// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/resources.lua:48-61 (the air resource's AI)
//             t-engine4 game/modules/tome/class/interface/ActorAI.lua:669-801 (grid hazard, safe grid)
//             t-engine4 game/modules/tome/class/Player.lua:1200-1217 (routing around what you cannot breathe)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A MONSTER AND THE WATER: IT GOES AROUND, AND IT COMES UP FOR AIR.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two rules, and both are about ground that hurts THIS body:
 *
 *   ROUTING. `approach` first asks A* for a route that refuses every tile
 *   `isHazardFor(code, self)` names, and takes the plain route only when that
 *   finds nothing.
 *
 *   AIR. `tome/data/resources.lua:48-61`, worked through once here:
 *
 *     deep water is `air_level -5`, regen is 3, so the rate is -2 and
 *     `air_time = air / 2`. Out of combat the chance is
 *     `100 - 100 * t / (t + 50)`, truncated by `rng.percent`. In combat a
 *     `t` over 20 never rolls, and any other `t` is multiplied by ten first.
 *
 *       air 40, out of combat: t 20  -> 71.43 -> percent(71)
 *       air 40, in combat:     t 200 -> 20    -> percent(20)
 *       air 42, in combat:     t 21  -> no roll at all
 *       air 20, in combat:     t 100 -> 33.33 -> percent(33)  (ten turns of air left)
 *       air 0:                 t 0   -> percent(100), certain, and still drawn
 *
 * `rng.percent(p)` is `rand_div(100) < (int)p` (shared/mapgen/lua.ts `percent`),
 * which is `ai.air.seek` below: a scripted roll of p-1 goes, a roll of p stays.
 */

import { describe, expect, it } from 'vitest';

import { decideNpcAction } from '../../src/server/ai/npc.ts';
import { INDEX_HUSK, monsterInit } from '../../src/server/content/monsters.ts';
import {
  AiProfile,
  IntentKind,
  createMonsterActor,
  createPlayerActor,
} from '../../src/server/engine/actor.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import type { World } from '../../src/server/world/world.ts';
import { DIR_VECTORS, chebyshev, tileIndex } from '../../src/shared/coords.ts';
import { TileCode, isWalkable } from '../../src/shared/protocol.ts';
import { createRng } from '../../src/shared/rng.ts';
import { drawCount, scriptedRng } from '../helpers/scripted-rng.ts';
import type { AiCtx } from '../../src/server/ai/npc.ts';
import type { EngineActor, Intent, MonsterActor } from '../../src/server/engine/actor.ts';
import type { TileXY } from '../../src/shared/coords.ts';
import type { Rng } from '../../src/shared/rng.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One character per tile. Anything unlisted is rock. */
const LEGEND: Readonly<Record<string, TileCode>> = {
  '.': TileCode.FLOOR,
  '#': TileCode.WALL,
  '~': TileCode.POND_WATER,
  o: TileCode.WATER_FLOOR_BUBBLE,
  f: TileCode.WATER_FLOOR_FAKE,
  '+': TileCode.DOOR,
  L: TileCode.LAVA_FLOOR,
};

function codeIn(rows: readonly string[]): (x: number, y: number) => number {
  return (x, y) => {
    const row = rows[y];
    if (row === undefined || x < 0 || x >= row.length) return TileCode.WALL;
    return LEGEND[row.charAt(x)] ?? TileCode.WALL;
  };
}

type CtxOpts = {
  /** Hand the AI the terrain. False is a fixture that knows no terrain rules. */
  readonly terrain?: boolean;
  readonly gridDamage?: AiCtx['gridDamage'];
  /** Route through shut doors, as `aiCtxFor` lets a door-opener. */
  readonly doors?: boolean;
};

/** The same shape as test/server/ai.test.ts's context, with the terrain seam. */
function ctxFor(
  rows: readonly string[],
  actors: readonly EngineActor[],
  rng: Rng,
  opts: CtxOpts = {},
): AiCtx {
  const codeAt = codeIn(rows);
  return {
    isPassable: (x, y) =>
      isWalkable(codeAt(x, y)) || (opts.doors === true && codeAt(x, y) === TileCode.DOOR),
    actorAt: (x, y) => actors.find((actor) => actor.alive && actor.x === x && actor.y === y),
    visibleEnemies: (self) =>
      actors
        .filter((actor) => actor.alive && actor.kind !== self.kind)
        .map((actor) => ({ actor, distance: chebyshev(self, actor) }))
        .filter((entry) => entry.distance <= self.ai.aggroRange)
        .sort((a, b) => a.distance - b.distance || (a.actor.id < b.actor.id ? -1 : 1))
        .map((entry) => entry.actor),
    actorById: (id) => actors.find((actor) => actor.id === id),
    // No walls in this fixture's sight, so none in its line either.
    lineClear: () => true,
    seesFrom: () => true,
    rng,
    ...(opts.terrain === false ? {} : { terrainAt: codeAt }),
    ...(opts.gridDamage === undefined ? {} : { gridDamage: opts.gridDamage }),
  };
}

function husk(
  at: TileXY,
  extra: { readonly noBreath?: boolean; readonly canBreath?: { readonly water?: number } } = {},
): MonsterActor {
  return createMonsterActor('m1', {
    name: 'm1',
    sprite: 'enemy_index_husk_s',
    x: at.x,
    y: at.y,
    profile: AiProfile.MeleeChaser,
    ...extra,
  });
}

function detective(at: TileXY): EngineActor {
  return createPlayerActor('p1', { name: 'p1', sprite: 'chr_player_watchman_s', x: at.x, y: at.y });
}

function moveOf(intent: Intent): { readonly dx: number; readonly dy: number } {
  if (intent.kind !== IntentKind.Move) throw new Error(`not a move: ${JSON.stringify(intent)}`);
  return DIR_VECTORS[intent.dir];
}

/** Walk a chaser until it swings, returning every tile it stood on. */
function walk(rows: readonly string[], monster: MonsterActor, player: EngineActor, ctx: AiCtx) {
  const codeAt = codeIn(rows);
  const stood: number[] = [];
  let attacked = false;
  for (let turn = 0; turn < 30 && !attacked; turn += 1) {
    const intent = decideNpcAction(monster, ctx);
    if (intent.kind === IntentKind.Attack) {
      attacked = true;
      break;
    }
    const { dx, dy } = moveOf(intent);
    monster.x += dx;
    monster.y += dy;
    stood.push(codeAt(monster.x, monster.y));
  }
  expect(chebyshev(monster, player) <= 1 || attacked).toBe(true);
  return { stood, attacked };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** A pond in the middle of the room: straight across is 6, around is 8. */
const POND_ROOM = [
  '#########',
  '#.......#',
  '#.~~~~~.#',
  '#.~~~~~.#',
  '#.~~~~~.#',
  '#.......#',
  '#########',
] as const;

describe('a monster routes around ground that would hurt it', () => {
  it('goes around the pond when there is a way around', () => {
    const player = detective({ x: 7, y: 3 });
    const monster = husk({ x: 1, y: 3 });
    const ctx = ctxFor(POND_ROOM, [player, monster], createRng('around'));
    const { stood, attacked } = walk(POND_ROOM, monster, player, ctx);
    expect(attacked).toBe(true);
    expect(stood).not.toContain(TileCode.POND_WATER);
  });

  it('PRECONDITION: without the terrain seam the same husk wades straight across', () => {
    const player = detective({ x: 7, y: 3 });
    const monster = husk({ x: 1, y: 3 });
    const ctx = ctxFor(POND_ROOM, [player, monster], createRng('around'), { terrain: false });
    expect(walk(POND_ROOM, monster, player, ctx).stood).toContain(TileCode.POND_WATER);
  });

  it('asks per body: `no_breath` and `can_breath.water` both wade, because it does not hurt them', () => {
    for (const extra of [{ noBreath: true }, { canBreath: { water: 1 } }]) {
      const player = detective({ x: 7, y: 3 });
      const monster = husk({ x: 1, y: 3 }, extra);
      const ctx = ctxFor(POND_ROOM, [player, monster], createRng('around'));
      expect(walk(POND_ROOM, monster, player, ctx).stood, JSON.stringify(extra)).toContain(
        TileCode.POND_WATER,
      );
    }
  });

  it('asks per code: real lava is avoided even by a body that never breathes, fake water is not', () => {
    const lava = POND_ROOM.map((row) => row.replaceAll('~', 'L'));
    const player = detective({ x: 7, y: 3 });
    const wraithlike = husk({ x: 1, y: 3 }, { noBreath: true });
    const burn = walk(lava, wraithlike, player, ctxFor(lava, [player, wraithlike], createRng('l')));
    expect(burn.stood).not.toContain(TileCode.LAVA_FLOOR);

    const fake = POND_ROOM.map((row) => row.replaceAll('~', 'f'));
    const breather = husk({ x: 1, y: 3 });
    const dry = walk(fake, breather, player, ctxFor(fake, [player, breather], createRng('f')));
    expect(dry.stood).toContain(TileCode.WATER_FLOOR_FAKE);
  });

  it('wades when the water is the only way through, rather than giving up', () => {
    const moat = ['#########', '#...~...#', '#...~...#', '#...~...#', '#########'];
    const player = detective({ x: 7, y: 2 });
    const monster = husk({ x: 1, y: 2 });
    const ctx = ctxFor(moat, [player, monster], createRng('moat'));
    const { stood, attacked } = walk(moat, monster, player, ctx);
    expect(attacked).toBe(true);
    expect(stood).toContain(TileCode.POND_WATER);
  });

  it('reaches a detective standing in the water, from the dry side', () => {
    // The goal is exempt: the detective's own tile never makes the dry route
    // fail, so the husk comes along the shore and steps in only at the end.
    const bay = ['#########', '#.......#', '#......~#', '#......~#', '#########'];
    const player = detective({ x: 7, y: 3 });
    const monster = husk({ x: 1, y: 3 });
    const ctx = ctxFor(bay, [player, monster], createRng('bay'));
    const { stood, attacked } = walk(bay, monster, player, ctx);
    expect(attacked).toBe(true);
    expect(stood).not.toContain(TileCode.POND_WATER);
  });
});

// ---------------------------------------------------------------------------
// The air trigger
// ---------------------------------------------------------------------------

/** A lake with dry ground only along the bottom row. */
const LAKE = [
  '#########',
  '#~~~~~~~#',
  '#~~~~~~~#',
  '#~~~~~~~#',
  '#.......#',
  '#########',
] as const;

/** A monster at the top of the lake with `air` left, and whatever it is fighting. */
function drowning(air: number, opts: { readonly inCombat: boolean; readonly rolls: number[] }) {
  const monster = husk({ x: 4, y: 1 });
  monster.air = air;
  const actors: EngineActor[] = [monster];
  if (opts.inCombat) {
    // Up in the water beside it, in sight, and the target it kept from last turn.
    const player = detective({ x: 7, y: 1 });
    actors.push(player);
    monster.ai.targetId = player.id;
  }
  const rng = scriptedRng(opts.rolls);
  return { monster, rng, ctx: ctxFor(LAKE, actors, rng) };
}

describe('the air resource AI — tome/data/resources.lua:48-61', () => {
  it('out of combat at 40 air: percent(71), so a roll of 70 heads for air and 71 does not', () => {
    const go = drowning(40, { inCombat: false, rolls: [70] });
    expect(moveOf(decideNpcAction(go.monster, go.ctx)).dy).toBe(1);
    expect(go.rng.getState().lastLabel).toBe('ai.air.seek');

    const stay = drowning(40, { inCombat: false, rolls: [71] });
    expect(decideNpcAction(stay.monster, stay.ctx).kind).toBe(IntentKind.Hold);
    expect(drawCount(stay.rng)).toBe(1);
  });

  it('in combat at 40 air: ten times the turns, percent(20)', () => {
    const go = drowning(40, { inCombat: true, rolls: [19] });
    expect(moveOf(decideNpcAction(go.monster, go.ctx)).dy).toBe(1);
    expect(drawCount(go.rng)).toBe(1);

    // A failed roll falls through to the fight, which takes its own draw.
    const stay = drowning(40, { inCombat: true, rolls: [20, 1] });
    const intent = decideNpcAction(stay.monster, stay.ctx);
    expect(stay.rng.getState().lastLabel).toBe('ai.target.keep');
    expect(moveOf(intent).dx).toBe(1);
  });

  it('in combat with ten turns of air left it heads for a safe grid a third of the time', () => {
    // air 20: t = 10, times ten = 100, 100 - 100*100/150 = 33.33, percent(33).
    const go = drowning(20, { inCombat: true, rolls: [32] });
    expect(moveOf(decideNpcAction(go.monster, go.ctx)).dy).toBe(1);
    const stay = drowning(20, { inCombat: true, rolls: [33, 1] });
    decideNpcAction(stay.monster, stay.ctx);
    expect(stay.rng.getState().lastLabel).toBe('ai.target.keep');
  });

  it('in combat with more than twenty turns left it does not even roll', () => {
    const fight = drowning(42, { inCombat: true, rolls: [1] });
    decideNpcAction(fight.monster, fight.ctx);
    expect(drawCount(fight.rng)).toBe(1);
    expect(fight.rng.getState().lastLabel).toBe('ai.target.keep');
  });

  it('at 0 air the roll is percent(100): certain, and still one draw', () => {
    const go = drowning(0, { inCombat: true, rolls: [99] });
    expect(moveOf(decideNpcAction(go.monster, go.ctx)).dy).toBe(1);
    expect(drawCount(go.rng)).toBe(1);
  });

  it('takes no draw for a full body, dry ground, `no_breath`, water it breathes, or a bubble', () => {
    const cases: {
      readonly name: string;
      readonly body: MonsterActor;
      readonly rows: readonly string[];
    }[] = [
      { name: 'full', body: husk({ x: 4, y: 1 }), rows: LAKE },
      { name: 'dry', body: husk({ x: 4, y: 4 }), rows: LAKE },
      { name: 'no_breath', body: husk({ x: 4, y: 1 }, { noBreath: true }), rows: LAKE },
      { name: 'can_breath', body: husk({ x: 4, y: 1 }, { canBreath: { water: 1 } }), rows: LAKE },
      { name: 'bubble', body: husk({ x: 4, y: 1 }), rows: LAKE.map((r) => r.replaceAll('~', 'o')) },
    ];
    for (const { name, body, rows } of cases) {
      if (name !== 'full') body.air = 10;
      const rng = scriptedRng([]);
      // Nobody to fight, so a body that does not seek air holds without drawing.
      expect(decideNpcAction(body, ctxFor(rows, [body], rng)).kind, name).toBe(IntentKind.Hold);
      expect(drawCount(rng), name).toBe(0);
    }
  });

  it('rolls when regeneration only matches the loss: `air_rate <= 0`, with `min(-1, rate)` below', () => {
    // Regen 5 against deep water's -5 is a rate of 0. The division is by -1, so
    // t = 50 turns and the chance is percent(50).
    for (const [roll, moves] of [
      [49, true],
      [50, false],
    ] as const) {
      const body = husk({ x: 4, y: 1 });
      body.air = 50;
      body.airRegen = 5;
      const rng = scriptedRng([roll]);
      const intent = decideNpcAction(body, ctxFor(LAKE, [body], rng));
      expect(intent.kind, `roll ${String(roll)}`).toBe(moves ? IntentKind.Move : IntentKind.Hold);
      expect(drawCount(rng)).toBe(1);
    }
  });

  it('takes no draw when the context knows no terrain', () => {
    const body = husk({ x: 4, y: 1 });
    body.air = 0;
    const rng = scriptedRng([]);
    decideNpcAction(body, ctxFor(LAKE, [body], rng, { terrain: false }));
    expect(drawCount(rng)).toBe(0);
  });

  it('with no safe ground in reach, the drawn turn goes to the fight', () => {
    // Water from wall to wall: nothing to head for, so the husk chases instead.
    const sealed = ['#####', '#~~~#', '#####'];
    const monster = husk({ x: 1, y: 1 });
    monster.air = 0;
    const player = detective({ x: 3, y: 1 });
    monster.ai.targetId = player.id;
    const rng = scriptedRng([99, 1]);
    const intent = decideNpcAction(monster, ctxFor(sealed, [monster, player], rng));
    expect(drawCount(rng)).toBe(2);
    expect(moveOf(intent).dx).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// aiFindSafeGrid
// ---------------------------------------------------------------------------

describe('aiFindSafeGrid — tome/class/interface/ActorAI.lua:726-801', () => {
  it('never picks a tile a body stands on, however near (`canMove`, :771)', () => {
    // The near shore holds its own kin; the far one is free.
    const rows = ['#########', '#.~~~~..#', '#########'];
    const monster = husk({ x: 3, y: 1 });
    monster.air = 0;
    const kin = createMonsterActor('m2', {
      name: 'm2',
      sprite: 'enemy_index_husk_s',
      x: 1,
      y: 1,
      profile: AiProfile.MeleeChaser,
    });
    const rng = scriptedRng([99]);
    expect(moveOf(decideNpcAction(monster, ctxFor(rows, [monster, kin], rng))).dx).toBe(1);
  });

  it('never picks a shut door, even for a body that may route through one', () => {
    // `canMove` asks `block_move` with no `couldpass`, so a door is solid to it.
    const rows = ['#########', '#+~~~~..#', '#########'];
    const monster = husk({ x: 2, y: 1 });
    monster.air = 0;
    const rng = scriptedRng([99]);
    const ctx = ctxFor(rows, [monster], rng, { doors: true });
    expect(moveOf(decideNpcAction(monster, ctx)).dx).toBe(1);
  });

  it('of two grids equally good, keeps the first it found: a strict `<` (:783)', () => {
    // Out of combat, shores three tiles either side. Nearest first, then by row
    // and column, reaches (1,1) before (7,1).
    const rows = ['#########', '#.~~~~~.#', '#########'];
    const monster = husk({ x: 4, y: 1 });
    monster.air = 0;
    const rng = scriptedRng([99]);
    expect(moveOf(decideNpcAction(monster, ctxFor(rows, [monster], rng))).dx).toBe(-1);
  });

  it('a bubble is no better than dry ground: it scores 0 too, so the nearer one wins', () => {
    // aiGridDamage counts only `air_level < 0` (:676). The bubble is two tiles
    // off and the floor one.
    const rows = ['#######', '#o~~.##', '#######'];
    const monster = husk({ x: 3, y: 1 });
    monster.air = 0;
    const rng = scriptedRng([99]);
    expect(moveOf(decideNpcAction(monster, ctxFor(rows, [monster], rng))).dx).toBe(1);
  });

  it('pays for A* only where a tile could still win: a shore beside it is one short search', () => {
    // A 25x25 lake, a dry tile beside the husk, and a dry column ten tiles off.
    // Nearest first finds the neighbour at once, and from then on a tile whose
    // straight-line score cannot beat it is never searched (:777). Measured:
    // 10 predicate calls. Scanning in grid order instead spends 514 before it
    // reaches the neighbour, and searching every tile spends 16,221.
    const W = 25;
    const code = (x: number, y: number): number => {
      if (x <= 0 || y <= 0 || x >= W - 1 || y >= W - 1) return TileCode.WALL;
      if ((x === 13 && y === 12) || x === 2) return TileCode.FLOOR;
      return TileCode.POND_WATER;
    };
    const monster = husk({ x: 12, y: 12 });
    monster.air = 0;
    let calls = 0;
    const ctx: AiCtx = {
      isPassable: (x, y) => {
        calls += 1;
        return isWalkable(code(x, y));
      },
      actorAt: () => undefined,
      visibleEnemies: () => [],
      actorById: () => undefined,
      lineClear: () => true,
      seesFrom: () => true,
      rng: scriptedRng([99]),
      terrainAt: code,
    };
    expect(moveOf(decideNpcAction(monster, ctx)).dx).toBe(1);
    expect(calls).toBeLessThan(50);
  });

  it('looks ten tiles out and no further (`radius or 10`, :754)', () => {
    // A flooded corridor with one dry tile at its end, ten tiles off and then eleven.
    for (const [far, moves] of [
      [10, true],
      [11, false],
    ] as const) {
      const rows = ['#'.repeat(far + 3), `#~${'~'.repeat(far - 1)}.#`, '#'.repeat(far + 3)];
      const monster = husk({ x: 1, y: 1 });
      monster.air = 0;
      const rng = scriptedRng([99]);
      const intent = decideNpcAction(monster, ctxFor(rows, [monster], rng));
      expect(intent.kind, `dry ground ${String(far)} tiles off`).toBe(
        moves ? IntentKind.Move : IntentKind.Hold,
      );
    }
  });

  it('never picks dry ground it cannot reach, however near', () => {
    // (1,1) is dry, two tiles away, and walled in. The shore at x=7 is four away.
    const rows = ['#########', '#.#~~~~.#', '###~~~~.#', '#~~~~~~.#', '#########'];
    const monster = husk({ x: 3, y: 2 });
    monster.air = 0;
    const rng = scriptedRng([99]);
    expect(moveOf(decideNpcAction(monster, ctxFor(rows, [monster], rng))).dx).toBe(1);
  });

  it('in combat, of two shores equally far, takes the one nearer its target (want_closer 0.5)', () => {
    const rows = ['#########', '#.~~~~~.#', '#.~~~~~.#', '#.~~~~~.#', '#########'];
    const monster = husk({ x: 4, y: 2 });
    monster.air = 0;
    const player = detective({ x: 7, y: 1 });
    monster.ai.targetId = player.id;
    const rng = scriptedRng([99]);
    expect(moveOf(decideNpcAction(monster, ctxFor(rows, [monster, player], rng))).dx).toBe(1);
  });

  it('aims at where it last saw a target it cannot see', () => {
    const rows = ['#########', '#.~~~~~.#', '#.~~~~~.#', '#.~~~~~.#', '#########'];
    const monster = husk({ x: 4, y: 2 });
    monster.air = 0;
    monster.ai.targetId = 'p_gone';
    monster.ai.lastSeen = { x: 7, y: 1 };
    const rng = scriptedRng([99]);
    expect(moveOf(decideNpcAction(monster, ctxFor(rows, [monster], rng))).dx).toBe(1);
  });

  it('prefers the bubble beside it to the shore: a bubble takes no air', () => {
    const rows = ['#########', '#~~~o~~~#', '#~~~~~~~#', '#~~~~~~~#', '#.......#', '#########'];
    const monster = husk({ x: 4, y: 2 });
    monster.air = 0;
    const rng = scriptedRng([99]);
    expect(moveOf(decideNpcAction(monster, ctxFor(rows, [monster], rng))).dy).toBe(-1);
  });

  it('out of combat a step costs a tenth, so it walks further for ground that does not hurt', () => {
    // Beside it a lava tile that burns 1% of its life a turn; five tiles off,
    // dry floor. Out of combat: lava 1 + 0.1 = 1.1, floor 5 * 0.1 = 0.5, so floor.
    // In combat both would be 1 + 1 = 2 against 5, and it would take the lava.
    const rows = ['###########', '#L~~~~~...#', '###########'];
    const monster = husk({ x: 2, y: 1 });
    monster.air = 0;
    const burns: AiCtx['gridDamage'] = (self, x, y) =>
      rows[y]?.charAt(x) === 'L' ? self.hp / 100 : 0;
    const rng = scriptedRng([99]);
    const ctx = ctxFor(rows, [monster], rng, { gridDamage: burns });
    expect(moveOf(decideNpcAction(monster, ctx)).dx).toBe(1);
  });

  it('divides the air term by `air + 1`, not by `air` (:702)', () => {
    // At 10 air the stand scores 5 * 100 / 11 = 45.5, under a lava neighbour's
    // 47 + 0.1, so it stays. Divided by 10 it would score 50, and it would step.
    const rows = ['####', '#L~#', '####'];
    const monster = husk({ x: 2, y: 1 });
    monster.air = 10;
    const burns: AiCtx['gridDamage'] = (self, x, y) =>
      rows[y]?.charAt(x) === 'L' ? 0.47 * self.hp : 0;
    const intent = decideNpcAction(
      monster,
      ctxFor(rows, [monster], scriptedRng([0]), { gridDamage: burns }),
    );
    expect(intent.kind === IntentKind.Move && intent.dir === 'w').toBe(false);
  });

  it('weighs a burn against the life the body HAS, not its maximum (`self.life`, :702)', () => {
    // Half a body's life gone: 0.7 * 100 / 50 = 1.4 + 0.1 beside it, against the
    // floor's 1.0 ten steps off. Against its maximum it would be 0.8, and lava.
    const rows = ['##############', '#L~~~~~~~~~~.#', '##############'];
    const monster = husk({ x: 2, y: 1 });
    monster.maxHp = 100;
    monster.hp = 50;
    monster.air = 0;
    const burns: AiCtx['gridDamage'] = (_self, x, y) => (rows[y]?.charAt(x) === 'L' ? 0.7 : 0);
    const ctx = ctxFor(rows, [monster], scriptedRng([99]), { gridDamage: burns });
    expect(moveOf(decideNpcAction(monster, ctx)).dx).toBe(1);
  });

  it('a hasted body pays less a step: `move_cost / global_speed` (:730)', () => {
    // Speed 2: lava 0.7 + 0.05 against floor 10 * 0.05 = 0.5. At speed 1 the
    // lava's 0.8 would beat the floor's 1.0.
    const rows = ['##############', '#L~~~~~~~~~~.#', '##############'];
    const monster = husk({ x: 2, y: 1 });
    monster.globalSpeed = 2;
    monster.air = 0;
    const burns: AiCtx['gridDamage'] = (self, x, y) =>
      rows[y]?.charAt(x) === 'L' ? 0.007 * self.hp : 0;
    const ctx = ctxFor(rows, [monster], scriptedRng([99]), { gridDamage: burns });
    expect(moveOf(decideNpcAction(monster, ctx)).dx).toBe(1);
  });

  it('a stunned body pays more a step: `combatMovementSpeed()` is the move cost (:730)', () => {
    // Out of combat, lava beside it burning 0.6 and dry floor five tiles off. At
    // movement speed 1 a step weighs 0.1: lava 0.7 against floor 0.5, so floor.
    // Stunned, speed 0.5, a step weighs 0.2: lava 0.8 against floor 1.0, so lava.
    const rows = ['#########', '#L~~~~~.#', '#########'];
    const burns: AiCtx['gridDamage'] = (self, x, y) =>
      rows[y]?.charAt(x) === 'L' ? 0.006 * self.hp : 0;
    const choice = (movementSpeed: number): number => {
      const monster = husk({ x: 2, y: 1 });
      monster.movementSpeed = movementSpeed;
      monster.air = 0;
      const ctx = ctxFor(rows, [monster], scriptedRng([99]), { gridDamage: burns });
      return moveOf(decideNpcAction(monster, ctx)).dx;
    };
    expect(choice(1), 'the steady husk should walk to the floor').toBe(1);
    expect(choice(0.5), 'the stunned husk should take the lava beside it').toBe(-1);
  });

  it('want_closer is 0.5 exactly, not merely something positive', () => {
    // Shores 2 west and 3 east; last seen at x = 7. At 0.5: west 2 + 2 = 4, east
    // 3 + 0.5 = 3.5, east. At 0.25: west 3, east 3.25, west.
    const rows = ['#############', '#~~.~~~~.~~~#', '#############'];
    const monster = husk({ x: 5, y: 1 });
    monster.air = 0;
    monster.ai.targetId = 'p_gone';
    monster.ai.lastSeen = { x: 7, y: 1 };
    expect(moveOf(decideNpcAction(monster, ctxFor(rows, [monster], scriptedRng([99])))).dx).toBe(1);
  });

  it('a tile whose straight-line score only TIES the best still pays for A* (`<=`, :777)', () => {
    // Out of combat. (5,1) is 4 away both ways; (4,4) is 4 in a straight line
    // but 3 by path, so it is really better, and only the search can say so.
    const rows = [
      '########',
      '#~~~~.~#',
      '#~~~~~~#',
      '#~~~~~~#',
      '#~~~.~~#',
      '#~~~~~~#',
      '########',
    ];
    const monster = husk({ x: 1, y: 1 });
    monster.air = 0;
    const step = moveOf(decideNpcAction(monster, ctxFor(rows, [monster], scriptedRng([99]))));
    expect(step).toEqual({ dx: 1, dy: 1 });
  });

  it('weighs a burn as a share of life (aiGridHazard, :702)', () => {
    // The same corridor, out of combat. A burn of a thousandth of its life
    // scores 0.1 + 0.1 = 0.2 beside it, under the floor's 0.5, so it takes
    // the lava. A hundredth scores 1.1, and the floor wins.
    const rows = ['###########', '#L~~~~~...#', '###########'];
    for (const [share, dx] of [
      [1000, -1],
      [100, 1],
    ] as const) {
      const monster = husk({ x: 2, y: 1 });
      monster.air = 0;
      const burns: AiCtx['gridDamage'] = (self, x, y) =>
        rows[y]?.charAt(x) === 'L' ? self.hp / share : 0;
      const rng = scriptedRng([99]);
      const ctx = ctxFor(rows, [monster], rng, { gridDamage: burns });
      expect(moveOf(decideNpcAction(monster, ctx)).dx, `a burn of 1/${String(share)}`).toBe(dx);
    }
  });
});

// ---------------------------------------------------------------------------
// Through the turn engine: the scheduler hands the AI the ground
// ---------------------------------------------------------------------------

function room(seed: string): World {
  const world = createWorld(seed);
  world.level.tiles.fill(TileCode.WALL);
  for (let y = 1; y <= 9; y += 1) {
    for (let x = 1; x <= 15; x += 1)
      world.level.tiles[tileIndex(x, y, world.level.w)] = TileCode.FLOOR;
  }
  return world;
}

function paint(world: World, x: number, y: number, code: TileCode): void {
  world.level.tiles[tileIndex(x, y, world.level.w)] = code;
}

describe('through the turn engine — `makeAiCtx` carries the terrain', () => {
  it('a husk chasing a detective across a room goes around the pond in the middle', () => {
    const world = room('ai-pond-join');
    for (let y = 3; y <= 7; y += 1) {
      for (let x = 5; x <= 11; x += 1) paint(world, x, y, TileCode.POND_WATER);
    }
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 1000 });
    dalt.x = 13;
    dalt.y = 5;
    const monster = world.addMonster('m_husk', monsterInit(INDEX_HUSK, { x: 3, y: 5 }));
    const engine = createTurnEngine({ world, now: () => 0 });
    engine.join('p1');

    const stood: number[] = [];
    for (let pump = 0; pump < 40 && chebyshev(monster, dalt) > 1; pump += 1) {
      engine.hold('p1');
      engine.pump();
      stood.push(world.level.tiles[tileIndex(monster.x, monster.y, world.level.w)] ?? -1);
    }
    expect(chebyshev(monster, dalt), 'the husk never arrived').toBeLessThanOrEqual(1);
    expect(stood).not.toContain(TileCode.POND_WATER);
  });

  it('a husk out of breath in a lake turns from the detective and makes for the shore', () => {
    const world = room('ai-air-join');
    // Water everywhere but the left-hand column, which is the only shore.
    for (let y = 1; y <= 9; y += 1) {
      for (let x = 2; x <= 15; x += 1) paint(world, x, y, TileCode.POND_WATER);
    }
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 1000 });
    dalt.x = 12;
    dalt.y = 5;
    dalt.noBreath = true;
    const monster = world.addMonster('m_husk', monsterInit(INDEX_HUSK, { x: 8, y: 5 }));
    // No breath coming back: every one of its turns is at 0 air, so every roll is
    // percent(100) and the outcome does not depend on the seed.
    monster.air = 0;
    monster.airRegen = 0;
    const engine = createTurnEngine({ world, now: () => 0 });
    engine.join('p1');

    const startX = monster.x;
    for (let pump = 0; pump < 3; pump += 1) {
      engine.hold('p1');
      engine.pump();
    }
    expect(monster.x, 'it waded towards the detective instead').toBeLessThan(startX);
  });

  it('a husk out of breath counts the floor`s lava roll: the shore, not the burning tile', () => {
    // Two dead ends off one pond, equally far from it and from the detective: lava
    // to the north, dry ground to the south. With no damage term they tie, and
    // the first found — the north, lower `y` — would win.
    const world = createWorld('ai-lava-join');
    world.level.tiles.fill(TileCode.WALL);
    paint(world, 5, 4, TileCode.LAVA_FLOOR);
    paint(world, 5, 6, TileCode.FLOOR);
    for (let x = 5; x <= 8; x += 1) paint(world, x, 5, TileCode.POND_WATER);
    paint(world, 9, 5, TileCode.FLOOR);
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 1000 });
    dalt.x = 9;
    dalt.y = 5;
    dalt.noBreath = true;
    const monster = world.addMonster('m_husk', monsterInit(INDEX_HUSK, { x: 5, y: 5 }));
    monster.air = 0;
    monster.airRegen = 0;
    expect(world.burnRange(TileCode.LAVA_FLOOR), 'precondition: real lava burns').toBeDefined();
    const engine = createTurnEngine({ world, now: () => 0 });
    engine.join('p1');

    const stood: number[] = [];
    for (let pump = 0; pump < 3; pump += 1) {
      engine.hold('p1');
      engine.pump();
      stood.push(world.level.tiles[tileIndex(monster.x, monster.y, world.level.w)] ?? -1);
    }
    expect(stood).not.toContain(TileCode.LAVA_FLOOR);
    expect(stood, 'it never made for the shore').toContain(TileCode.FLOOR);
  });
});
