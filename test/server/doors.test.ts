import { describe, expect, it } from 'vitest';

import { EffectId, createMvpEffectState } from '../../src/server/content/effects.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { setEffect } from '../../src/server/engine/effects.ts';
import { canOpenDoors, isClosedDoor } from '../../src/server/engine/doors.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import type { Actor, World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WALKING INTO A DOOR — `tome/class/Grid.lua:59-92`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * if self.door_opened and e.open_door and act then
 *   game.level.map(x, y, engine.Map.TERRAIN, door_g)
 *   return true                                  -- BLOCKED, and the door opened
 * ```
 *
 * The half that is easy to get backwards, and the half these tests exist for:
 * the step does NOT happen, and for a PLAYER it costs nothing. `Actor.lua:1346`
 * charges a move only `(self.x ~= ox or self.y ~= oy)`, and a door-open leaves
 * the body where it was.
 */

const HUSK_SPRITE = 'enemy_index_husk_s';
const LANE_Y = 5;

type Scene = {
  readonly world: World;
  readonly engine: ReturnType<typeof createTurnEngine>;
  readonly actor: (id: string) => Actor;
};

/**
 * A corridor with a door in it. Ren stands at x=2 facing east; the door is the
 * tile at x=3, so ONE step east is a step into it.
 */
function scene(
  seed: string,
  options: {
    readonly withHusk?: boolean;
    readonly ahead?: number;
    readonly huskOpensDoors?: boolean;
  } = {},
): Scene {
  const world = createWorld(seed);
  world.level.tiles.fill(TileCode.WALL);
  for (let x = 1; x < 12; x += 1) {
    world.level.tiles[LANE_Y * world.level.w + x] = TileCode.FLOOR;
  }
  world.level.tiles[LANE_Y * world.level.w + 3] = options.ahead ?? TileCode.DOOR;

  const ren = world.addPlayer('p1', 'Ren');
  ren.x = 2;
  ren.y = LANE_Y;
  ren.hpRegen = 0;

  if (options.withHusk === true) {
    const husk = world.addMonster('m_husk', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: 6,
      y: LANE_Y,
      profile: AiProfile.MeleeChaser,
      maxHp: 200,
      opensDoors: options.huskOpensDoors ?? true,
    });
    husk.hpRegen = 0;
  }

  const engine = createTurnEngine({ world, now: () => 0 });
  engine.join('p1');

  return {
    world,
    engine,
    actor: (id) => {
      const found = world.getActor(id);
      if (found === undefined) throw new Error(`test fixture: actor ${id} is missing`);
      return found;
    },
  };
}

describe('a player walking into a door', () => {
  it('opens it, and does NOT step through', () => {
    /**
     * BOTH HALVES IN ONE TEST, because either alone passes for the wrong build.
     * A build that opened the door AND stepped through would satisfy "the door
     * is open"; a build that refused without opening would satisfy "the body did
     * not move". `return true` from `block_move` is what makes it exactly these
     * two facts at once.
     */
    const table = scene('door-open');
    expect(isClosedDoor(table.world.level, 3, LANE_Y)).toBe(true);

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    expect(table.world.level.tiles[LANE_Y * table.world.level.w + 3], 'the door did not open').toBe(
      TileCode.DOOR_OPEN,
    );
    expect(table.actor('p1').x, 'the body walked through the door it just opened').toBe(2);
  });

  it('COSTS THE PLAYER NO TIME — Actor.lua:1346', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE SINGLE MOST IMPORTANT NUMBER IN THIS PORT, AND IT IS ZERO.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Upstream gates the movement energy charge on the body actually changing
     * tile, so a door-open is free — `PlayerExplore.lua:2563` says so in words:
     * *"takes a movement action but no energy to do."* Walking through a doorway
     * therefore costs ONE turn in total, not two.
     *
     * ═══ MEASURED AS A DIFFERENCE, BECAUSE THE ABSOLUTE NUMBER IS THE FIXTURE ═══
     * The first draft asserted `gameTurn` had not moved at all and read 1. That
     * is not the door: a fresh actor starts with no energy, so the loop must
     * spend a whole game turn GRANTING it before the move can resolve at all.
     * The turn was the fixture's, not the player's.
     *
     * So all three cases run the identical geometry and differ only in the tile
     * ahead. A DOOR must cost exactly what a WALL costs — both refuse — and a
     * step onto FLOOR must cost strictly more, or "free" is an untested word.
     */
    const cost = (ahead: number): number => {
      const table = scene(`door-cost-${String(ahead)}`, { ahead });
      const before = table.world.turn.clock.gameTurn;
      expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
      table.engine.pump();
      return table.world.turn.clock.gameTurn - before;
    };

    const intoWall = cost(TileCode.WALL);
    const intoDoor = cost(TileCode.DOOR);
    const ontoFloor = cost(TileCode.FLOOR);

    expect(intoDoor, 'opening a door cost more than being refused by a wall').toBe(intoWall);
    expect(ontoFloor, 'the fixture cannot tell a step from a refusal').toBeGreaterThan(intoWall);
  });

  it('steps through on the very next move, for one turn all told', () => {
    const table = scene('door-through');

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();
    expect(table.actor('p1').x).toBe(2);

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();
    expect(table.actor('p1').x, 'the open doorway was still solid').toBe(3);
  });

  it('is refused, and the refusal is NOT reported to the player', () => {
    /**
     * A door-open is the one refusal in the engine that is not a failure. Every
     * other one reaches its owner as `refused at resolution: <reason>`; toasting
     * that over a door the player just watched swing would teach them that
     * opening doors is a malfunction.
     *
     * ASSERTED ON `refusals`, which is the exact list the gateway turns into
     * `sendError` calls — so this pins the thing the player sees rather than an
     * internal flag that correlates with it.
     */
    const table = scene('door-quiet');
    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    const result = table.engine.pump();

    expect(result.refusals, 'opening a door raised an error on the player').toEqual([]);
    // AND THE DOOR REALLY DID OPEN, so this is not green by nothing happening.
    expect(table.world.level.tiles[LANE_Y * table.world.level.w + 3]).toBe(TileCode.DOOR_OPEN);
  });
});

describe('who may open one — Player.lua:62 and the bestiary', () => {
  it('lets any player through, without a field to say so', () => {
    const world = createWorld('door-who');
    const ren = world.addPlayer('p1', 'Ren');
    expect(canOpenDoors(ren)).toBe(true);
  });

  it('refuses a monster that does not declare it, and that default is upstream', () => {
    // `open_door` is set in `Player:init` and on ~fifty NPC templates
    // individually; absent means no. `npcs/crystal.lua:71` says `false` out
    // loud, which is the tell that the absent case is a design position.
    const world = createWorld('door-who-not');
    const mute = world.addMonster('m_mute', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: 1,
      y: 1,
      profile: AiProfile.MeleeChaser,
      maxHp: 10,
    });
    expect(canOpenDoors(mute)).toBe(false);

    const handed = world.addMonster('m_handed', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: 2,
      y: 1,
      profile: AiProfile.MeleeChaser,
      maxHp: 10,
      opensDoors: true,
    });
    expect(canOpenDoors(handed), 'MonsterInit.opensDoors never reached the actor').toBe(true);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A ROOM WHERE THE MONSTER CAN SEE YOU AND CANNOT WALK TO YOU DIRECTLY.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Getting a monster to walk into a door is harder than it sounds, and the
   * reason is the feature working: a shut door BLOCKS SIGHT, so a husk with a
   * door between it and the party has no visible enemy, never takes a target,
   * and never goes anywhere. Every straightforward corridor fixture tests that
   * instead, silently.
   *
   * WATER is what separates the two questions. It is the one family that is
   * solid and TRANSPARENT (`SOLID_BUT_CLEAR` in protocol.ts), so the husk sees
   * Ren straight across the channel at (3,5) and cannot swim it. The only route
   * is the footbridge one row north, and there is a door on it.
   *
   *     y=4   # . + . #        <- the way round, with the door at (3,4)
   *     y=5   # R ~ H #        <- Ren, the channel, the husk
   */
  function detour(seed: string, opensDoors: boolean): Scene {
    const world = createWorld(seed);
    world.level.tiles.fill(TileCode.WALL);
    const put = (x: number, y: number, code: number): void => {
      world.level.tiles[y * world.level.w + x] = code;
    };
    for (const x of [2, 3, 4]) put(x, 4, TileCode.FLOOR);
    for (const x of [2, 3, 4]) put(x, 5, TileCode.FLOOR);
    put(3, 4, TileCode.DOOR);
    put(3, 5, TileCode.WATER);

    const ren = world.addPlayer('p1', 'Ren');
    ren.x = 2;
    ren.y = 5;
    ren.hpRegen = 0;

    const husk = world.addMonster('m_husk', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: 4,
      y: 5,
      profile: AiProfile.MeleeChaser,
      maxHp: 200,
      opensDoors,
    });
    husk.hpRegen = 0;

    const engine = createTurnEngine({ world, now: () => 0 });
    engine.join('p1');
    world.turn.engagement = 3;

    return {
      world,
      engine,
      actor: (id) => {
        const found = world.getActor(id);
        if (found === undefined) throw new Error(`test fixture: actor ${id} is missing`);
        return found;
      },
    };
  }

  it('is opened by a husk that has hands, routing round to reach you', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE TEST THAT WAS MISSING, AND ITS ABSENCE HID DEAD CODE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The first version of this file only asserted that a HANDLESS creature
     * left the door shut, and it passed with the `canOpenDoors` gate DELETED —
     * because nothing in it ever walked a monster into a door at all.
     * `intentForStep` refuses an impassable tile, so with a terrain-only
     * predicate the AI cannot propose the step, and the monster half of this
     * feature was unreachable code. `aiCtxFor` is what makes it reachable, and
     * this is what proves it.
     */
    const table = detour('door-husk', true);

    for (let i = 0; i < 8; i += 1) {
      expect(table.engine.submitMove('p1', i % 2 === 0 ? 'n' : 's').ok).toBe(true);
      table.engine.pump();
    }

    expect(
      isClosedDoor(table.world.level, 3, 4),
      'a husk with open_door never worked the handle it was routing through',
    ).toBe(false);
  });

  it('leaves the door shut for a creature with no hands', () => {
    /**
     * THE SAME ROOM, THE SAME CHASE, ONE FIELD DIFFERENT. Paired with the test
     * above rather than written alone, because alone it is green on a build
     * where no monster can open anything — which is exactly the build this file
     * used to be testing without knowing.
     */
    const table = detour('door-mute', false);

    for (let i = 0; i < 8; i += 1) {
      expect(table.engine.submitMove('p1', i % 2 === 0 ? 'n' : 's').ok).toBe(true);
      table.engine.pump();
    }

    expect(
      isClosedDoor(table.world.level, 3, 4),
      'a creature with no open_door worked a door handle',
    ).toBe(true);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RESOLUTION GATE, AND THE ONE THING THAT REACHES IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `resolveIntent` checks `canOpenDoors` before swinging anything, and the AI
 * checks it too (`aiCtxFor`) — so for an ordinary monster the second check is
 * unreachable and deleting it breaks NO test. MEASURED, not assumed: that
 * mutation was run and came back green.
 *
 * CONFUSION IS WHAT REACHES IT. `confusedStep` substitutes a random direction
 * AFTER the AI has decided, at the top of the Move resolution, so a confused
 * body is aimed at a tile no passability predicate was ever consulted about —
 * upstream does the same at `Actor.lua:1316-1321`, substituting the destination
 * at the top of `move` and letting the rest of it run. A handless creature
 * stumbling into a door must still not open it.
 *
 * This is also why the gate stays even though the AI now duplicates it: the
 * scheduler's own note says a monster *"cannot walk through a wall via a code
 * path no player takes"* because BOTH lanes go through `resolveIntent`. A rule
 * enforced only in the AI is a rule with one enforcement point too few.
 */
describe('a confused body stumbling into a door', () => {
  const DOOR_XS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
  const DOOR_ROWS = [LANE_Y - 1, LANE_Y + 1];
  const DOOR_COUNT = DOOR_XS.length * DOOR_ROWS.length;

  /**
   * A corridor with a door in every wall panel, and a husk walking down it.
   *
   *     y=4   # + + + + + + + + + + + #
   *     y=5   # . R . . . . . . H . . .
   *     y=6   # + + + + + + + + + + + #
   *
   * ═══ WHY IT IS A PLAIN CHASE AND NOT SOMETHING CLEVERER ═══
   * Three earlier fixtures failed here and each failed the same way, which is
   * worth recording because the shape is not obvious: `confusedStep` only ever
   * rewrites a MOVE, so a husk that proposes no move is a husk that never
   * stumbles. A husk proposes no move when it has no visible enemy (a shut door
   * blocks sight, so anything behind one simply holds), and ALSO when it has one
   * it cannot step toward — `intentForStep` returns undefined for an impassable
   * tile, so a husk pinned against a channel holds just as silently.
   *
   * So the husk needs a target it can see AND a legitimate step toward it, every
   * turn. An ordinary corridor chase is the simplest thing that is both, and the
   * doors go in the SIDE walls where the AI would never route: every door opened
   * here was opened by the scramble and by nothing else.
   *
   * Ren paces between two FLOOR tiles on the centre line and can never reach a
   * door herself — a player opens one unconditionally, and an earlier draft had
   * her opening the husk's door for it.
   */
  function stumbler(seed: string, opensDoors: boolean) {
    const world = createWorld(seed);
    world.level.tiles.fill(TileCode.WALL);
    const put = (x: number, y: number, code: number): void => {
      world.level.tiles[y * world.level.w + x] = code;
    };
    for (let x = 1; x <= 14; x += 1) put(x, LANE_Y, TileCode.FLOOR);
    for (const x of DOOR_XS) for (const y of DOOR_ROWS) put(x, y, TileCode.DOOR);

    const ren = world.addPlayer('p1', 'Ren');
    ren.x = 2;
    ren.y = LANE_Y;
    ren.hpRegen = 0;
    // SHE IS HERE TO BE LOOKED AT, NOT TO SURVIVE A FIGHT. The husk closes and
    // starts swinging; a fixture where the target dies half way through stops
    // producing the moves this test is counting.
    ren.maxHp = 9999;
    ren.hp = 9999;

    const husk = world.addMonster('m_husk', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      // INSIDE `DEFAULT_SIGHT_RADIUS` (10). At twelve tiles it is not a husk
      // that ignores doors, it is a husk that cannot see anybody — which is
      // what the draft before this one was measuring.
      x: 9,
      y: LANE_Y,
      profile: AiProfile.MeleeChaser,
      maxHp: 500,
      opensDoors,
    });
    husk.hpRegen = 0;

    const effects = createMvpEffectState();
    setEffect(effects, husk, EffectId.Confused, 400, {}, world.rng);

    const engine = createTurnEngine({ world, now: () => 0, effects });
    engine.join('p1');
    return { world, engine };
  }

  const shutAfterStumbling = (seed: string, opensDoors: boolean): number => {
    const table = stumbler(seed, opensDoors);
    for (let i = 0; i < 12; i += 1) {
      // Re-armed each pass: engagement decays, and a husk that stops taking
      // turns stops stumbling long before the loop is up.
      table.world.turn.engagement = 60;
      table.engine.submitMove('p1', i % 2 === 0 ? 'e' : 'w');
      table.engine.pump();
    }
    let shut = 0;
    for (const x of DOOR_XS) {
      for (const y of DOOR_ROWS) if (isClosedDoor(table.world.level, x, y)) shut += 1;
    }
    return shut;
  };

  it('opens some when it has hands — the positive control', () => {
    // WITHOUT THIS the test below is green on a build where the husk never
    // stumbles into anything, which is the failure this file has already made
    // once and which took three fixtures to stop making.
    expect(
      shutAfterStumbling('door-stumble', true),
      'a confused husk with hands blundered into none of the doors lining the corridor',
    ).toBeLessThan(DOOR_COUNT);
  });

  it('opens NONE when it has none, however long it blunders', () => {
    // THE SAME SEED, so the scramble takes the identical path and the only
    // difference between the two runs is the one field.
    expect(
      shutAfterStumbling('door-stumble', false),
      'a confused handless husk opened a door by stumbling into it',
    ).toBe(DOOR_COUNT);
  });
});

describe('the world is the only thing allowed to swing one', () => {
  it('refuses to open anything that is not a shut door', () => {
    const world = createWorld('door-guard');
    world.level.tiles.fill(TileCode.FLOOR);
    world.level.tiles[LANE_Y * world.level.w + 4] = TileCode.WALL;
    world.level.tiles[LANE_Y * world.level.w + 5] = TileCode.DOOR_OPEN;

    expect(world.openDoor(3, LANE_Y), 'floor was opened as if it were a door').toBe(false);
    expect(world.openDoor(4, LANE_Y), 'a WALL was opened').toBe(false);
    expect(world.openDoor(5, LANE_Y), 'an already-open door was opened again').toBe(false);
    expect(world.openDoor(-1, LANE_Y), 'a tile off the grid was opened').toBe(false);
    expect(world.terrainChanges(), 'a refused open still recorded a change').toEqual([]);
  });

  it('records the change once, however many times it is asked', () => {
    const world = createWorld('door-once');
    world.level.tiles.fill(TileCode.FLOOR);
    world.level.tiles[LANE_Y * world.level.w + 3] = TileCode.DOOR;

    expect(world.openDoor(3, LANE_Y)).toBe(true);
    expect(world.openDoor(3, LANE_Y), 'the second open was not a no-op').toBe(false);
    expect(world.terrainChanges()).toEqual([
      { x: 3, y: LANE_Y, code: TileCode.DOOR_OPEN, was: TileCode.DOOR },
    ]);
  });
});

describe('restoreTerrain — a wipe must not pay', () => {
  it('shuts the doors again and KEEPS them in the list, flipped', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ENTRY STAYS. DELETING IT IS THE BUG THIS ASSERTION EXISTS FOR.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `TerrainMsg` is absolute but the client applies it by ASSIGNMENT, so a
     * tile that simply stops being mentioned keeps whatever the client last
     * wrote. Dropping the entry would shut the door on the server and leave it
     * standing open on every screen, permanently — and no server-side assertion
     * about `level.tiles` would notice.
     */
    const world = createWorld('door-reset');
    world.level.tiles.fill(TileCode.FLOOR);
    world.level.tiles[LANE_Y * world.level.w + 3] = TileCode.DOOR;
    expect(world.openDoor(3, LANE_Y)).toBe(true);

    world.restoreTerrain();

    expect(world.level.tiles[LANE_Y * world.level.w + 3]).toBe(TileCode.DOOR);
    expect(world.terrainChanges(), 'the restored tile left the list the client reads').toEqual([
      { x: 3, y: LANE_Y, code: TileCode.DOOR, was: TileCode.DOOR },
    ]);
  });

  it('will NOT shut a door on a body standing in it', () => {
    /**
     * The one terrain change in the game that can happen under somebody. A door
     * shut on a body puts it inside solid, sight-blocking terrain: `canWalk` is
     * false in every direction, nothing can see in, and no verb in this game
     * digs. The tile keeps its OPEN code in the list, because it is open.
     */
    const world = createWorld('door-occupied');
    world.level.tiles.fill(TileCode.FLOOR);
    world.level.tiles[LANE_Y * world.level.w + 3] = TileCode.DOOR;
    expect(world.openDoor(3, LANE_Y)).toBe(true);

    const ren = world.addPlayer('p1', 'Ren');
    ren.x = 3;
    ren.y = LANE_Y;

    world.restoreTerrain();

    expect(
      world.level.tiles[LANE_Y * world.level.w + 3],
      'a door was shut on somebody standing in it',
    ).toBe(TileCode.DOOR_OPEN);
    expect(world.terrainChanges()).toEqual([
      { x: 3, y: LANE_Y, code: TileCode.DOOR_OPEN, was: TileCode.DOOR },
    ]);
  });
});
