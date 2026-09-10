// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The rule being guarded is `on_die`, dispatched by
// t-engine4 game/engines/default/engine/interface/ActorLife.lua:91
// (`self:check("on_die", src, death_note)`), reached from
// t-engine4 game/modules/tome/class/Actor.lua:2975.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { describe, expect, it } from 'vitest';

import { AiProfile } from '../../src/server/engine/actor.ts';
import { BLEEDING, EffectId } from '../../src/server/content/effects.ts';
import { DamageType } from '../../src/server/engine/damage.ts';
import { createDownedState } from '../../src/server/engine/downed.ts';
import { createEffectState, registerEffect, setEffect } from '../../src/server/engine/effects.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import type { OnDeathZone } from '../../src/server/engine/actor.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A CREATURE LEAVES ON THE FLOOR — `on_die`, and the SECOND grave.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * -- general/npcs/vermin.lua:82-91, the carrion worm mass
 * on_die = function(self, src)
 *   game.level.map:addEffect(self, self.x, self.y, 5,
 *     engine.DamageType.BLIGHT, self:getStr(90, true), 2, 5, nil, ...)
 * ```
 *
 * ═══ THE WHOLE POINT OF THIS FILE IS THE SECOND LANE ═══
 * A monster dies in TWO places in this engine, and only one of them is obvious.
 * `noteCasualty` buries every blow-driven death across six lanes;
 * `resolveStatusHits` buries a monster killed by a bleed and used to duplicate
 * the same four actions inline, because `noteCasualty` derives its victims from
 * an `Effect` and a damage-over-time tick produces none.
 *
 * Four duplicated lines were survivable. A FIFTH thing that has to happen on
 * death is not: added to one site and not the other, a creature bled out rather
 * than hit would silently fail to do the thing it was authored to do, and
 * nothing anywhere would go red. `noteMonsterDeath` is the one body both lanes
 * now call, and the bleed test below is the reason it exists.
 */

const CLOUD: OnDeathZone = {
  radius: 1,
  type: DamageType.Physical,
  damage: 3,
  turns: 4,
  friendlyFire: true,
};

describe('a creature that bursts when it dies', () => {
  /** A husk on a known tile, killable either way, with the cloud attached. */
  const stage = (seed: string, options: { readonly onDie?: OnDeathZone } = {}) => {
    const world = createWorld(seed);
    world.level.tiles.fill(TileCode.FLOOR);
    const effects = createEffectState();
    registerEffect(effects, BLEEDING);
    const engine = createTurnEngine({ world, downed: createDownedState(), effects });

    const ren = world.addPlayer('p1', 'Ren');
    ren.x = 5;
    ren.y = 5;
    ren.hpRegen = 0;
    // Accuracy that beats any defence here, so a kill is decided by the fixture
    // rather than by the seed.
    ren.combat = { mods: { atk: 30, dam: 500 } };

    const husk = world.addMonster('m1', {
      name: 'Index Husk',
      sprite: 'enemy_index_husk_s',
      x: 6,
      y: 5,
      profile: AiProfile.MeleeChaser,
      ...(options.onDie === undefined ? {} : { onDie: options.onDie }),
    });
    husk.maxHp = 3;
    husk.hp = 3;
    husk.hpRegen = 0;
    world.turn.engagement = 3;
    engine.join('p1');

    return { world, engine, effects, husk };
  };

  it('leaves a patch of ground where it fell, when it is CUT DOWN', () => {
    const table = stage('ondie-blow', { onDie: CLOUD });
    expect(table.world.zones(), 'the floor started dirty').toEqual([]);

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    expect(table.world.getActor('m1')?.alive ?? true, 'the husk survived the swing').toBe(false);
    const zones = table.world.zones();
    expect(zones, 'a creature with an onDie row left nothing').toHaveLength(1);
    // CENTRED ON THE TILE IT DIED ON. `spillLoot`'s note is what makes this
    // possible: the corpse is ENROLLED rather than removed, so `victim.x/y` is
    // still the tile it fell on when the row is read.
    expect(zones[0]?.tiles).toContainEqual({ x: 6, y: 5 });
    expect(zones[0]?.type).toBe(DamageType.Physical);
    /**
     * NOT `toBe(4)`. The zone is created mid-pump and the same pump goes on to
     * cross more than one game-turn boundary, so `tickGroundZones` has already
     * burnt some of it off by the time the call returns — the first draft
     * asserted the authored duration and read 2, which is the fixture
     * disagreeing with the assumption rather than the row being wrong.
     *
     * The authored figure is pinned where it can be: `validateTemplate` refuses
     * a non-positive `turns`, and `zones.test.ts` pins the expiry arithmetic.
     */
    expect(zones[0]?.turnsLeft ?? 0).toBeGreaterThan(0);
    expect(zones[0]?.turnsLeft ?? 0).toBeLessThanOrEqual(CLOUD.turns);
  });

  it('leaves one when it is BLED OUT — the lane that had its own grave', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ASSERTION THIS FILE EXISTS FOR.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * No blow, no `Effect`, no `noteCasualty`. Before `noteMonsterDeath` this
     * lane had its own four-line copy of the burial, and an `on_die` added to
     * the obvious site would have been missing from here — a worm mass that
     * bled out would drop no cloud and the suite would stay green.
     */
    const table = stage('ondie-bleed', { onDie: CLOUD });
    setEffect(table.effects, table.husk, EffectId.Bleeding, 20, { power: 5 }, table.world.rng);

    for (let turn = 0; turn < 8; turn += 1) table.engine.pump();

    // THE SETUP HAS TO HAVE WORKED BEFORE THE CLAIM MEANS ANYTHING — a bleed
    // that never ticked would satisfy the claim by leaving a husk standing.
    expect(table.world.getActor('m1')?.alive ?? true, 'the bleed never killed it').toBe(false);
    expect(table.world.zones(), 'a bled-out creature left no cloud').toHaveLength(1);
    expect(table.world.zones()[0]?.tiles).toContainEqual({ x: 6, y: 5 });
  });

  it('leaves NOTHING when the creature authors no row', () => {
    // Most of the roster declines this, and the tactic a death cloud creates
    // only exists while that is true. Absent must also cost no draw — see
    // `noteMonsterDeath` — which is what keeps every existing seed identical.
    const table = stage('ondie-absent');

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    expect(table.world.getActor('m1')?.alive ?? true).toBe(false);
    expect(table.world.zones(), 'a creature with no onDie row still burst').toEqual([]);
  });

  it('STOPS AT A WALL rather than pooling in the corridor beyond it', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * `engine/Map.lua:1103-1104` — `core.fov.circle_grids(x, y, radius, true)`.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The `true` is a blocking flag, so upstream's ball is not a disc of
     * coordinates: it is the part of a disc the centre can see. `ballTiles`
     * knows nothing about terrain, so the filter is applied where the zone is
     * built — see `visibleFrom` for why it cannot go in `ballTiles` itself.
     *
     * ═══ ASSERTED BY COORDINATE, NEVER BY COUNT ═══
     * A `tiles.length` assertion passes under a filter that drops the WRONG
     * tile, which is the whole shape of "membership is not a rank". The tile in
     * front of the wall must be present and the one behind it must be absent,
     * by name.
     */
    const table = stage('ondie-wall', { onDie: CLOUD });
    // A wall due north of where the husk will die, and the tile beyond it.
    const wall = { x: 6, y: 4 };
    const beyond = { x: 6, y: 3 };
    table.world.level.tiles[wall.y * table.world.level.w + wall.x] = TileCode.WALL;

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    const tiles = table.world.zones()[0]?.tiles ?? [];
    expect(tiles, 'the cloud was not laid at all').toContainEqual({ x: 6, y: 5 });
    // THE TILE IN FRONT SURVIVES and the wall does not. Radius 1 does not reach
    // `beyond`, so the wall itself is the assertion with teeth here — it is
    // inside the ball, and `hasLineOfSight` alone would keep it, because that
    // function walks the INTERIOR of the line and a neighbouring wall has no
    // interior. `canWalk` is the clause that removes it.
    expect(tiles, 'the tile in front of the wall was dropped too').toContainEqual({ x: 5, y: 5 });
    expect(tiles, 'the cloud filled the wall it was born beside').not.toContainEqual(wall);
    expect(tiles, 'the cloud reached past the wall').not.toContainEqual(beyond);
  });

  it('does not reach AROUND a wall — the blocking flag, at a radius that shows it', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE RADIUS IS THE FIXTURE. AT ONE, THIS CLAUSE CANNOT BE OBSERVED.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `visibleFrom` has two clauses and the test above only proves one of them.
     * Every tile of a radius-1 ball is ADJACENT to the centre, so nothing is
     * ever behind anything and `hasLineOfSight` is true for all five — deleting
     * it left that test green. The Glut authors radius 1, so with today's
     * content the line-of-sight half is unobservable in play.
     *
     * It is not unobservable in the helper, and the helper is general: the next
     * creature or talent to lay a zone will not be radius 1. So this drives the
     * real death path with a radius-2 row and a wall, where the tile diagonally
     * behind the wall is inside the ball, is walkable, and must still be absent.
     */
    const table = stage('ondie-wall-reach', {
      onDie: { ...CLOUD, radius: 2 },
    });
    // A wall due west of the death tile at (6,5), and the floor beyond it.
    const wall = { x: 5, y: 5 };
    const behind = { x: 4, y: 5 };
    table.world.level.tiles[wall.y * table.world.level.w + wall.x] = TileCode.WALL;
    // The detective cannot bump east through its own wall, so it kills from the north.
    const ren = table.world.getActor('p1');
    if (ren === undefined) throw new Error('fixture: no detective');
    ren.x = 6;
    ren.y = 4;

    expect(table.engine.submitMove('p1', 's').ok).toBe(true);
    table.engine.pump();

    const tiles = table.world.zones()[0]?.tiles ?? [];
    expect(tiles, 'the cloud was not laid at all').toContainEqual({ x: 6, y: 5 });
    // Inside the ball, walkable, and on the far side of the wall.
    expect(tiles, 'the cloud reached around the wall').not.toContainEqual(behind);
    // ...while the same distance in the clear direction is kept, so this is the
    // WALL doing the work and not the radius.
    expect(tiles, 'the cloud lost a tile it had line of sight to').toContainEqual({ x: 8, y: 5 });
  });

  it('burns whoever is standing in it on the following turns', () => {
    /**
     * THE JOIN, not the halves. `zones.test.ts` proves a zone burns; this
     * proves the one the DEATH placed is a real one the scheduler ticks — the
     * difference being the two lines between `noteMonsterDeath` and
     * `tickGroundZones`, which is exactly where a zone that is created but
     * never registered would hide.
     */
    const table = stage('ondie-burns', { onDie: CLOUD });

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();
    expect(table.world.zones()).toHaveLength(1);

    // The detective steps ONTO the tile the husk died on and stands there.
    const ren = table.world.getActor('p1');
    if (ren === undefined) throw new Error('fixture: no detective');
    ren.x = 6;
    ren.y = 5;
    const before = ren.hp;

    const clockBefore = table.world.turn.clock.gameTurn;
    expect(table.engine.submitMove('p1', 'w').ok).toBe(true);
    table.engine.pump();
    ren.x = 6;
    ren.y = 5;

    const turns = table.world.turn.clock.gameTurn - clockBefore;
    expect(turns, 'the clock did not move').toBeGreaterThan(0);
    expect(ren.hp, 'the cloud the corpse left did not burn anybody').toBeLessThan(before);
  });
});
