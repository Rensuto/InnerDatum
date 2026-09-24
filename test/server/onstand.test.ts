// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/general/grids/lava.lua:30-39 (the burn)
//             t-engine4 game/modules/tome/data/general/grids/water.lua:104-115 (the bubble)
//             t-engine4 game/engines/default/engine/resolvers.lua:85-92 (resolvers.calc.mbonus)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `on_stand`: LAVA THAT BURNS, AND A BUBBLE THAT RUNS OUT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three layers, each tested where it lives, and then the join driven through a
 * real `createTurnEngine` and a real `createRealms`, because a rule that is
 * right in `onstand.ts` and never reached from the pump is not a rule.
 */

import { describe, expect, it } from 'vitest';

import { INDEX_HUSK, INDEX_WRAITH, monsterInit } from '../../src/server/content/monsters.ts';
import { AiProfile, HOLD_INTENT } from '../../src/server/engine/actor.ts';
import { createBarrier } from '../../src/server/engine/barrier.ts';
import {
  DOWNED_TURNS,
  createDownedState,
  downedView,
  isDowned,
} from '../../src/server/engine/downed.ts';
import {
  BUBBLES_DEPLETED,
  DEFAULT_TERRAIN_LEVEL,
  MBONUS_MAX_LEVEL,
  bubbleOf,
  burnMessage,
  burnOf,
  resolveBurn,
  resolveMbonus,
  rollBubbleCharges,
  rollBurn,
  spendsBubble,
  terrainSourceId,
} from '../../src/server/engine/onstand.ts';
import type { Bubble, Burn } from '../../src/server/engine/onstand.ts';
import { pump, submitIntent } from '../../src/server/engine/scheduler.ts';
import { trapSentence } from '../../src/server/engine/traps.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { projectTerrain } from '../../src/server/view/projector.ts';
import { SITES, createRealms } from '../../src/server/world/realms.ts';
import { createWorld } from '../../src/server/world/world.ts';
import type { World } from '../../src/server/world/world.ts';
import { tileIndex } from '../../src/shared/coords.ts';
import { DamageType } from '../../src/shared/damagetype.ts';
import { mbonus } from '../../src/shared/mapgen/lua.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import type { TurnEvent } from '../../src/shared/protocol.ts';
import { createRng } from '../../src/shared/rng.ts';
import type { Rng } from '../../src/shared/rng.ts';

const HUSK_SPRITE = 'enemy_index_husk_s';

function lava(): Burn {
  const burn = burnOf(TileCode.LAVA_FLOOR);
  if (burn === undefined) throw new Error('fixture: LAVA_FLOOR does not burn');
  return burn;
}

function bubble(): Bubble {
  const found = bubbleOf(TileCode.WATER_FLOOR_BUBBLE);
  if (found === undefined) throw new Error('fixture: WATER_FLOOR_BUBBLE is not a bubble');
  return found;
}

/** A generator whose `int` draws are scripted, and which refuses a value outside the asked range. */
function scriptedInts(values: readonly number[]): Rng {
  const queue = [...values];
  return {
    ...createRng('scripted'),
    int: (_label, lo, hi) => {
      const v = queue.shift();
      if (v === undefined) throw new Error('script ran out');
      if (v < lo || v > hi) {
        throw new Error(`scripted ${String(v)} outside ${String(lo)}..${String(hi)}`);
      }
      return v;
    },
  };
}

function flat(seed: string): World {
  const world = createWorld(seed);
  world.level.tiles.fill(TileCode.FLOOR);
  return world;
}

function paint(world: World, x: number, y: number, code: TileCode): void {
  world.level.tiles[tileIndex(x, y, world.level.w)] = code;
}

/** One tile of `code` walled on all eight sides, so nothing standing in it can leave. */
function pocket(world: World, x: number, y: number, code: TileCode): void {
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) paint(world, x + dx, y + dy, TileCode.WALL);
  }
  paint(world, x, y, code);
}

/** What `createWorld(seed)` rolls for a bubble at (x, y): its own fork, per tile. */
function chargesFor(seed: string, x: number, y: number): number {
  const fork = createRng(seed)
    .fork('terrain.bubble')
    .fork(`${String(x)},${String(y)}`);
  return rollBubbleCharges(fork, bubble());
}

type Engine = ReturnType<typeof createTurnEngine>;
type PumpOut = ReturnType<Engine['pump']>;
type DamageFrame = Extract<TurnEvent, { readonly k: 'damage' }>;

/** Everyone holds and the engine pumps once, whatever that first pump costs in turns. */
function settle(world: World, engine: Engine, ids: readonly string[]): void {
  for (const id of ids) expect(engine.hold(id).ok).toBe(true);
  engine.pump();
  expect(world.turn.clock.gameTurn, 'precondition: the clock started').toBeGreaterThan(0);
}

/** Everyone holds, and the pump must cost EXACTLY one game turn. */
function oneTurn(world: World, engine: Engine, ids: readonly string[]): PumpOut {
  const turn = world.turn.clock.gameTurn;
  for (const id of ids) expect(engine.hold(id).ok).toBe(true);
  const result = engine.pump();
  expect(world.turn.clock.gameTurn - turn, 'one hold is one game turn').toBe(1);
  return result;
}

function damageTo(events: readonly TurnEvent[], id: string): DamageFrame[] {
  const out: DamageFrame[] = [];
  for (const event of events) if (event.k === 'damage' && event.id === id) out.push(event);
  return out;
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`fixture: ${what} is missing`);
  return value;
}

// ---------------------------------------------------------------------------
// THE RESOLVER — resolvers.calc.mbonus, and lava's two numbers
// ---------------------------------------------------------------------------

describe('resolvers.calc.mbonus (engine/resolvers.lua:90-92)', () => {
  it('is rng.mbonus at ToME`s ceiling of 90, plus the flat term', () => {
    expect(MBONUS_MAX_LEVEL).toBe(90);
    expect(DEFAULT_TERRAIN_LEVEL).toBe(1);
    // The first draw is `range(0, max_level - 1)`: 89 is legal only at a ceiling of 90.
    const rng = createRng('mbonus-calc');
    const twin = createRng('mbonus-calc');
    for (let n = 0; n < 50; n += 1) {
      expect(resolveMbonus(rng, 'r', [10, 30], 7)).toBe(mbonus(twin, 't', 10, 7, 90) + 30);
    }
    expect(resolveMbonus(scriptedInts([89, 3]), 'r', [3, 15], 1)).toBe(15);
  });

  it('resolves lava`s mindam first and its maxdam second, on one stream', () => {
    const rng = createRng('lava-resolve');
    const twin = createRng('lava-resolve');
    for (let n = 0; n < 50; n += 1) {
      const level = 1 + (n % 60);
      const got = resolveBurn(rng, lava(), level);
      const min = resolveMbonus(twin, 'min', [5, 15], level);
      const max = resolveMbonus(twin, 'max', [10, 30], level);
      expect(got).toEqual({ min, max });
    }
  });

  it('keeps lava`s damage in 15..20 and 30..40 at every level (data/general/grids/lava.lua:30-31)', () => {
    const rng = createRng('lava-bounds');
    const mins = new Set<number>();
    const maxes = new Set<number>();
    for (let level = 1; level <= 120; level += 1) {
      for (let n = 0; n < 20; n += 1) {
        const { min, max } = resolveBurn(rng, lava(), level);
        expect(min).toBeGreaterThanOrEqual(15);
        expect(min).toBeLessThanOrEqual(20);
        expect(max).toBeGreaterThanOrEqual(30);
        expect(max).toBeLessThanOrEqual(40);
        mins.add(min);
        maxes.add(max);
      }
    }
    // Both ends are reachable, so neither term is a constant in disguise.
    expect([...mins].sort((a, b) => a - b)).toEqual([15, 16, 17, 18, 19, 20]);
    expect(Math.min(...maxes)).toBe(30);
    expect(Math.max(...maxes)).toBe(40);
  });

  it('rolls one burn in mindam..maxdam, both ends inclusive (data/general/grids/lava.lua:36)', () => {
    const rng = createRng('lava-roll');
    const seen = new Set<number>();
    for (let n = 0; n < 400; n += 1) seen.add(rollBurn(rng, { min: 15, max: 18 }));
    expect([...seen].sort((a, b) => a - b)).toEqual([15, 16, 17, 18]);
    // Equal ends draw nothing, as `rng.range` does.
    const still = createRng('lava-roll-equal');
    const before = still.getState().count;
    expect(rollBurn(still, { min: 20, max: 20 })).toBe(20);
    expect(still.getState().count).toBe(before);
  });
});

describe('who spends a bubble`s charge (data/general/grids/water.lua:107)', () => {
  it('everybody who cannot breathe water and does breathe', () => {
    expect(spendsBubble({})).toBe(true);
    // Lua's 0 is truthy, and `0 <= 0`: a zero count is "cannot".
    expect(spendsBubble({ canBreath: { water: 0 } })).toBe(true);
    expect(spendsBubble({ canBreath: { water: -1 } })).toBe(true);
    expect(spendsBubble({ canBreath: {} })).toBe(true);
    expect(spendsBubble({ canBreath: { water: 1 } })).toBe(false);
    expect(spendsBubble({ noBreath: true })).toBe(false);
    expect(spendsBubble({ noBreath: true, canBreath: { water: 0 } })).toBe(false);
    expect(spendsBubble({ noBreath: false })).toBe(true);
  });

  it('rolls 4..7 charges (resolvers.rngrange(4, 7), :104)', () => {
    const rng = createRng('bubble-charges');
    const seen = new Set<number>();
    for (let n = 0; n < 300; n += 1) seen.add(rollBubbleCharges(rng, bubble()));
    expect([...seen].sort((a, b) => a - b)).toEqual([4, 5, 6, 7]);
  });
});

describe('the sentences', () => {
  it('says "#Source# burns #Target#!" with the grid`s name capitalised', () => {
    expect(trapSentence(burnMessage(TileCode.LAVA_FLOOR), 'dalt')).toBe('Lava floor burns Dalt!');
    expect(BUBBLES_DEPLETED).toBe('The air bubbles are depleted!');
    expect(terrainSourceId(TileCode.LAVA_FLOOR)).toBe('terrain:lava');
  });
});

// ---------------------------------------------------------------------------
// THE WORLD — one resolution per floor, charges per tile, one terrain writer
// ---------------------------------------------------------------------------

describe('World.burnRange and World.setTerrainLevel', () => {
  it('resolves once, on its own fork, at the floor`s level, and never again', () => {
    const world = flat('burn-range');
    expect(world.terrainLevel()).toBe(DEFAULT_TERRAIN_LEVEL);
    expect(world.setTerrainLevel(37)).toBe(true);
    expect(world.terrainLevel()).toBe(37);

    const first = need(world.burnRange(TileCode.LAVA_FLOOR), 'the lava range');
    const fork = createRng('burn-range').fork('terrain.resolve').fork(String(TileCode.LAVA_FLOOR));
    expect(first).toEqual(resolveBurn(fork, lava(), 37));
    expect(world.burnRange(TileCode.LAVA_FLOOR)).toBe(first);
  });

  it('reads the level it was given, not level 1 — two floors of one seed differ', () => {
    // Found by search: the first seed whose level-1 and level-89 pairs differ,
    // so a world that ignored its level could not pass by coincidence.
    let seed = '';
    for (let i = 0; i < 200 && seed === ''; i += 1) {
      const fork = createRng(`levels-${String(i)}`)
        .fork('terrain.resolve')
        .fork(String(TileCode.LAVA_FLOOR));
      const low = resolveBurn(fork, lava(), 1);
      const high = resolveBurn(
        createRng(`levels-${String(i)}`)
          .fork('terrain.resolve')
          .fork(String(TileCode.LAVA_FLOOR)),
        lava(),
        89,
      );
      if (low.min !== high.min || low.max !== high.max) seed = `levels-${String(i)}`;
    }
    expect(seed, 'no seed separates level 1 from level 89').not.toBe('');

    const shallow = flat(seed);
    const deep = flat(seed);
    expect(deep.setTerrainLevel(89)).toBe(true);
    expect(deep.burnRange(TileCode.LAVA_FLOOR)).not.toEqual(shallow.burnRange(TileCode.LAVA_FLOOR));
  });

  it('is write-once, and refuses after anything has resolved', () => {
    const once = flat('level-once');
    expect(once.setTerrainLevel(4)).toBe(true);
    expect(once.setTerrainLevel(9)).toBe(false);
    expect(once.terrainLevel()).toBe(4);

    const late = flat('level-late');
    need(late.burnRange(TileCode.LAVA_FLOOR), 'the lava range');
    expect(late.setTerrainLevel(9), 'the lava already burnt at level 1').toBe(false);
    expect(late.terrainLevel()).toBe(DEFAULT_TERRAIN_LEVEL);

    expect(flat('level-nan').setTerrainLevel(Number.NaN)).toBe(false);
  });

  it('answers undefined for every code that burns nobody, the FAKE twin included', () => {
    const world = flat('burn-none');
    for (const code of Object.values(TileCode)) {
      if (code === TileCode.LAVA_FLOOR) continue;
      expect(world.burnRange(code), `code ${String(code)}`).toBeUndefined();
    }
  });
});

describe('World.spendBubble and World.depleteBubble', () => {
  it('rolls a tile`s charges on its own fork the first time, then counts down', () => {
    const world = flat('bubble-spend');
    paint(world, 4, 4, TileCode.WATER_FLOOR_BUBBLE);
    const rolled = chargesFor('bubble-spend', 4, 4);
    expect(world.spendBubble(4, 4)).toBe(rolled - 1);
    expect(world.spendBubble(4, 4)).toBe(rolled - 2);
    expect(world.spendBubble(5, 4), 'plain floor is no bubble').toBeUndefined();
    expect(world.spendBubble(-1, 4)).toBeUndefined();
    // Off the east edge of row 4 is, as an index, the first tile of row 5 — and
    // that one IS a bubble, so only the bounds check can say no.
    paint(world, 0, 5, TileCode.WATER_FLOOR_BUBBLE);
    expect(world.spendBubble(world.level.w, 4)).toBeUndefined();
    expect(world.depleteBubble(world.level.w, 4)).toBe(false);
    expect(world.spendBubble(0.5, 4)).toBeUndefined();
  });

  it('gives each bubble its own count, whichever is found first', () => {
    let seed = '';
    for (let i = 0; i < 200 && seed === ''; i += 1) {
      if (chargesFor(`pair-${String(i)}`, 2, 2) !== chargesFor(`pair-${String(i)}`, 6, 2)) {
        seed = `pair-${String(i)}`;
      }
    }
    expect(seed, 'no seed gives two bubbles different counts').not.toBe('');
    const ab = flat(seed);
    const ba = flat(seed);
    for (const world of [ab, ba]) {
      paint(world, 2, 2, TileCode.WATER_FLOOR_BUBBLE);
      paint(world, 6, 2, TileCode.WATER_FLOOR_BUBBLE);
    }
    const a1 = ab.spendBubble(2, 2);
    const b1 = ab.spendBubble(6, 2);
    const b2 = ba.spendBubble(6, 2);
    const a2 = ba.spendBubble(2, 2);
    expect(a1).toBe(a2);
    expect(b1).toBe(b2);
    expect(a1).not.toBe(b1);
  });

  it('turns only a bubble into water, through the terrain delta the wire reads', () => {
    const world = flat('bubble-deplete');
    paint(world, 4, 4, TileCode.WATER_FLOOR_BUBBLE);
    paint(world, 5, 4, TileCode.WATER_FLOOR);
    expect(world.depleteBubble(5, 4)).toBe(false);
    expect(world.depleteBubble(6, 4)).toBe(false);
    expect(world.depleteBubble(-3, 4)).toBe(false);
    expect(world.terrainChanges()).toEqual([]);

    expect(world.depleteBubble(4, 4)).toBe(true);
    expect(world.level.tiles[tileIndex(4, 4, world.level.w)]).toBe(TileCode.WATER_FLOOR);
    expect(world.terrainChanges()).toEqual([
      { x: 4, y: 4, code: TileCode.WATER_FLOOR, was: TileCode.WATER_FLOOR_BUBBLE },
    ]);
    expect(projectTerrain(world).tiles).toEqual([{ x: 4, y: 4, code: TileCode.WATER_FLOOR }]);
    expect(world.depleteBubble(4, 4), 'water is no bubble').toBe(false);
  });

  it('is put back full by the floor reset, and a second depletion keeps the generated code', () => {
    const world = flat('bubble-restore');
    paint(world, 4, 4, TileCode.WATER_FLOOR_BUBBLE);
    paint(world, 8, 4, TileCode.WATER_FLOOR_BUBBLE);
    const rolled = chargesFor('bubble-restore', 8, 4);
    world.spendBubble(8, 4);
    world.spendBubble(8, 4);
    world.depleteBubble(4, 4);

    world.restoreTerrain();
    expect(world.level.tiles[tileIndex(4, 4, world.level.w)]).toBe(TileCode.WATER_FLOOR_BUBBLE);
    expect(world.spendBubble(8, 4), 'a half-spent bubble stayed half spent').toBe(rolled - 1);

    world.depleteBubble(4, 4);
    expect(world.terrainChanges()).toEqual([
      { x: 4, y: 4, code: TileCode.WATER_FLOOR, was: TileCode.WATER_FLOOR_BUBBLE },
    ]);
  });
});

// ---------------------------------------------------------------------------
// THE JOIN — the scheduler's pass, through a real turn engine
// ---------------------------------------------------------------------------
//
// OFF THE DIAGONAL, every tile below: a pass that read `(y, x)` finds the same
// tile at (10, 10) and a dry one at (12, 4).

describe('standing on lava, through the turn engine', () => {
  it('burns a player once per game turn, inside the resolved range, and says so', () => {
    const world = flat('lava-join');
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 100_000 });
    dalt.x = 12;
    dalt.y = 4;
    dalt.hpRegen = 0;
    const engine = createTurnEngine({ world, now: () => 0 });
    engine.join('p1');
    settle(world, engine, ['p1']);
    paint(world, 12, 4, TileCode.LAVA_FLOOR);
    const span = need(world.burnRange(TileCode.LAVA_FLOOR), 'the lava range');

    const losses = new Set<number>();
    for (let pump = 0; pump < 40; pump += 1) {
      const hp = dalt.hp;
      const result = oneTurn(world, engine, ['p1']);
      const lost = hp - dalt.hp;
      expect(lost).toBeGreaterThanOrEqual(span.min);
      expect(lost).toBeLessThanOrEqual(span.max);
      losses.add(lost);
      expect(result.records ?? []).toEqual(['Lava floor burns Dalt!']);
      expect(damageTo(result.playerEvents, 'p1')).toEqual([
        { k: 'damage', id: 'p1', amount: lost, hp: dalt.hp, maxHp: 100_000, type: DamageType.Fire },
      ]);
    }
    expect(losses.size, 'every burn was the same number').toBeGreaterThan(1);
  });

  it('never burns on the FAKE twin, or on plain floor', () => {
    for (const code of [TileCode.LAVA_FLOOR_FAKE, TileCode.FLOOR]) {
      const world = flat(`lava-fake-${String(code)}`);
      const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 1000 });
      dalt.x = 12;
      dalt.y = 4;
      dalt.hpRegen = 0;
      paint(world, 12, 4, code);
      const engine = createTurnEngine({ world, now: () => 0 });
      engine.join('p1');
      for (let pump = 0; pump < 10; pump += 1) {
        engine.hold('p1');
        expect(engine.pump().records ?? []).toEqual([]);
      }
      expect(dalt.hp).toBe(1000);
    }
  });

  it('is fire, so a fire resist takes it — and a full resist is silent (`dam > 0`, :38)', () => {
    const world = flat('lava-resist');
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 100_000 });
    dalt.x = 12;
    dalt.y = 4;
    dalt.hpRegen = 0;
    const engine = createTurnEngine({ world, now: () => 0 });
    engine.join('p1');
    settle(world, engine, ['p1']);
    paint(world, 12, 4, TileCode.LAVA_FLOOR);
    const span = need(world.burnRange(TileCode.LAVA_FLOOR), 'the lava range');

    dalt.combat = { ...dalt.combat, profile: { resists: { fire: 50 } } };
    for (let pump = 0; pump < 10; pump += 1) {
      const hp = dalt.hp;
      oneTurn(world, engine, ['p1']);
      expect(hp - dalt.hp).toBeGreaterThanOrEqual(span.min / 2 - 1);
      expect(hp - dalt.hp).toBeLessThanOrEqual(span.max / 2 + 1);
    }

    dalt.combat = { ...dalt.combat, profile: { resists: { fire: 100 } } };
    const hp = dalt.hp;
    for (let pump = 0; pump < 5; pump += 1) {
      const result = oneTurn(world, engine, ['p1']);
      expect(result.records ?? []).toEqual([]);
      expect(damageTo(result.playerEvents, 'p1')).toEqual([]);
    }
    expect(dalt.hp).toBe(hp);

    // AND A PHYSICAL RESIST DOES NOTHING: the type is the grid's, not a default.
    dalt.combat = { ...dalt.combat, profile: { resists: { physical: 100 } } };
    oneTurn(world, engine, ['p1']);
    expect(dalt.hp).toBeLessThan(hp);
  });

  it('kills a monster, and the kill is enrolled for burial; its pocket of floor does not', () => {
    const world = flat('lava-kill');
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 100 });
    dalt.x = 30;
    dalt.y = 30;
    pocket(world, 5, 7, TileCode.LAVA_FLOOR);
    pocket(world, 9, 5, TileCode.FLOOR);
    const burnt = world.addMonster('m_burnt', monsterInit(INDEX_HUSK, { x: 5, y: 7 }));
    const dry = world.addMonster('m_dry', monsterInit(INDEX_HUSK, { x: 9, y: 5 }));
    burnt.hp = 1;
    dry.hp = 1;
    burnt.hpRegen = 0;
    dry.hpRegen = 0;
    const engine = createTurnEngine({ world, now: () => 0 });
    engine.join('p1');

    engine.hold('p1');
    const result = engine.pump();
    expect(result.reaped).toEqual(['m_burnt']);
    expect(result.records ?? [], 'a monster`s burn narrated to the room').toEqual([]);
    expect(dry.alive).toBe(true);
  });

  it('downs a player, through the same enrolment a blow uses', () => {
    const world = flat('lava-down');
    const downed = createDownedState();
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 100 });
    const ren = world.addPlayer('p2', 'Ren', { maxHp: 100 });
    dalt.x = 12;
    dalt.y = 4;
    ren.x = 20;
    ren.y = 20;
    dalt.hp = 1;
    dalt.hpRegen = 0;
    paint(world, 12, 4, TileCode.LAVA_FLOOR);
    const engine = createTurnEngine({ world, now: () => 0, downed });
    engine.join('p1');
    engine.join('p2');

    engine.hold('p1');
    engine.hold('p2');
    engine.pump();
    expect(dalt.alive).toBe(false);
    expect(isDowned(downed, 'p1')).toBe(true);
  });

  it('burns a hasted body once a game turn, not once an action (D5-4)', () => {
    const world = flat('lava-haste');
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 100 });
    dalt.x = 30;
    dalt.y = 30;
    pocket(world, 5, 7, TileCode.LAVA_FLOOR);
    const fast = world.addMonster('m_fast', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: 5,
      y: 7,
      profile: AiProfile.MeleeChaser,
      maxHp: 100_000,
      globalSpeed: 3,
    });
    fast.hpRegen = 0;
    const engine = createTurnEngine({ world, now: () => 0 });
    engine.join('p1');

    settle(world, engine, ['p1']);
    let burns = 0;
    for (let pump = 0; pump < 10; pump += 1) {
      burns += damageTo(oneTurn(world, engine, ['p1']).playerEvents, 'm_fast').length;
    }
    expect(burns, 'one burn per game turn').toBe(10);
  });

  it('burns a slowed body once a game turn too, though it acts less often (D5-4)', () => {
    // Upstream's `on_stand` is in `act()` (tome/class/Actor.lua:681): a body at
    // half speed would burn on half the turns. Ours hangs off the base clock.
    const world = flat('lava-slow');
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 100 });
    dalt.x = 30;
    dalt.y = 30;
    pocket(world, 5, 7, TileCode.LAVA_FLOOR);
    const slow = world.addMonster('m_slow', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: 5,
      y: 7,
      profile: AiProfile.MeleeChaser,
      maxHp: 100_000,
      globalSpeed: 0.5,
    });
    slow.hpRegen = 0;
    const engine = createTurnEngine({ world, now: () => 0 });
    engine.join('p1');

    settle(world, engine, ['p1']);
    let burns = 0;
    for (let pump = 0; pump < 10; pump += 1) {
      burns += damageTo(oneTurn(world, engine, ['p1']).playerEvents, 'm_slow').length;
    }
    expect(burns, 'one burn per game turn').toBe(10);
  });

  it('is an ambient blow: nobody swung it', () => {
    const world = flat('lava-ambient');
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 100_000 });
    dalt.x = 12;
    dalt.y = 4;
    dalt.hpRegen = 0;
    paint(world, 12, 4, TileCode.LAVA_FLOOR);
    const barrier = createBarrier();
    const events: unknown[] = [];
    for (let turn = 0; turn < 3; turn += 1) {
      submitIntent(world, barrier, 'p1', HOLD_INTENT);
      events.push(...pump(world, { nowMs: 0, barrier }).events);
    }
    const burns = events.filter(
      (event) =>
        (event as { t?: string }).t === 'attacked' &&
        (event as { id?: string }).id === terrainSourceId(TileCode.LAVA_FLOOR),
    );
    expect(burns.length).toBeGreaterThan(0);
    for (const burn of burns) expect((burn as { ambient?: boolean }).ambient).toBe(true);
  });

  it('tells the talent seam the body was struck, as any blow does (break-on-damage)', () => {
    const world = flat('lava-struck');
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 100_000 });
    dalt.x = 12;
    dalt.y = 4;
    dalt.hpRegen = 0;
    paint(world, 12, 4, TileCode.LAVA_FLOOR);
    const barrier = createBarrier();
    const struck: string[] = [];
    const talents = {
      use: () => ({ ok: false, reason: 'unknown_talent' }),
      actBase: () => undefined,
      noteMoved: () => undefined,
      noteKill: () => undefined,
      noteStruck: (id: string) => struck.push(id),
      markMultiplier: () => 1,
      guardCounter: () => null,
      spillOrder: () => [],
    };
    for (let turn = 0; turn < 4; turn += 1) {
      submitIntent(world, barrier, 'p1', HOLD_INTENT);
      pump(world, { nowMs: 0, barrier, talents } as unknown as Parameters<typeof pump>[1]);
    }
    expect(dalt.hp, 'precondition: it burnt').toBeLessThan(100_000);
    expect(struck).toContain('p1');
  });

  it('a lava down starts a full countdown: the pass runs after `survivalPass`', () => {
    const world = flat('lava-countdown');
    const downed = createDownedState();
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 100 });
    const ren = world.addPlayer('p2', 'Ren', { maxHp: 100 });
    dalt.x = 12;
    dalt.y = 4;
    ren.x = 20;
    ren.y = 15;
    dalt.hpRegen = 0;
    const engine = createTurnEngine({ world, now: () => 0, downed });
    engine.join('p1');
    engine.join('p2');
    settle(world, engine, ['p1', 'p2']);
    dalt.hp = 1;
    paint(world, 12, 4, TileCode.LAVA_FLOOR);
    oneTurn(world, engine, ['p1', 'p2']);
    expect(isDowned(downed, 'p1')).toBe(true);
    expect(downedView(downed, 'p1')?.turnsLeft).toBe(DOWNED_TURNS);
  });
});

describe('standing in an air bubble, through the turn engine', () => {
  it('spends one charge a game turn, then becomes water, says so, and the wire carries it', () => {
    const seed = 'bubble-join';
    const world = flat(seed);
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 1000 });
    dalt.x = 12;
    dalt.y = 4;
    dalt.hpRegen = 0;
    const engine = createTurnEngine({ world, now: () => 0 });
    engine.join('p1');
    settle(world, engine, ['p1']);
    paint(world, 12, 4, TileCode.WATER_FLOOR_BUBBLE);
    const charges = chargesFor(seed, 12, 4);

    for (let turn = 1; turn <= charges; turn += 1) {
      expect(world.level.tiles[tileIndex(12, 4, world.level.w)]).toBe(TileCode.WATER_FLOOR_BUBBLE);
      const said = oneTurn(world, engine, ['p1']).records ?? [];
      expect(said, `after game turn ${String(turn)}`).toEqual(
        turn === charges ? [BUBBLES_DEPLETED] : [],
      );
    }
    expect(world.level.tiles[tileIndex(12, 4, world.level.w)]).toBe(TileCode.WATER_FLOOR);
    expect(projectTerrain(world).tiles).toEqual([{ x: 12, y: 4, code: TileCode.WATER_FLOOR }]);
  });

  it('runs after the air step: the turn a bubble runs out still gave its +15', () => {
    const seed = 'bubble-order';
    const world = flat(seed);
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 1000 });
    dalt.x = 12;
    dalt.y = 4;
    const engine = createTurnEngine({ world, now: () => 0 });
    engine.join('p1');
    settle(world, engine, ['p1']);
    paint(world, 12, 4, TileCode.WATER_FLOOR_BUBBLE);
    const charges = chargesFor(seed, 12, 4);
    dalt.air = 0;

    let expected = 0;
    for (let turn = 1; turn <= charges; turn += 1) {
      oneTurn(world, engine, ['p1']);
      // `regenResources` bounds first (tome/class/Actor.lua:558), then the bubble's
      // `suffocate(-15)` (:589), and only then `on_stand` (:681).
      expected = Math.min(100, Math.max(0, expected + 3)) + 15;
    }
    expect(world.level.tiles[tileIndex(12, 4, world.level.w)]).toBe(TileCode.WATER_FLOOR);
    expect(dalt.air).toBe(expected);
  });

  it('is not spent by a body that breathes water, nor by one that does not breathe', () => {
    const seed = 'bubble-keep';
    const world = flat(seed);
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 1000 });
    dalt.x = 12;
    dalt.y = 4;
    dalt.canBreath = { water: 1 };
    paint(world, 12, 4, TileCode.WATER_FLOOR_BUBBLE);
    pocket(world, 5, 7, TileCode.WATER_FLOOR_BUBBLE);
    world.addMonster('m_wraith', monsterInit(INDEX_WRAITH, { x: 5, y: 7 }));
    const engine = createTurnEngine({ world, now: () => 0 });
    engine.join('p1');
    for (let pump = 0; pump < 12; pump += 1) {
      engine.hold('p1');
      engine.pump();
    }
    expect(world.terrainChanges()).toEqual([]);
    // Fresh: the first spend is the rolled count less one.
    expect(world.spendBubble(12, 4)).toBe(chargesFor(seed, 12, 4) - 1);
    expect(world.spendBubble(5, 7)).toBe(chargesFor(seed, 5, 7) - 1);
  });

  it('is spent by a monster that breathes, silently', () => {
    const seed = 'bubble-husk';
    const world = flat(seed);
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 1000 });
    dalt.x = 30;
    dalt.y = 30;
    pocket(world, 5, 7, TileCode.WATER_FLOOR_BUBBLE);
    world.addMonster('m_husk', monsterInit(INDEX_HUSK, { x: 5, y: 7 }));
    const engine = createTurnEngine({ world, now: () => 0 });
    engine.join('p1');
    settle(world, engine, ['p1']);
    const said: string[] = [];
    for (let pump = 0; pump < chargesFor(seed, 5, 7); pump += 1) {
      said.push(...(oneTurn(world, engine, ['p1']).records ?? []));
    }
    expect(world.level.tiles[tileIndex(5, 7, world.level.w)]).toBe(TileCode.WATER_FLOOR);
    expect(said).toEqual([]);
  });

  it('is not spent by a body lying downed in it', () => {
    const seed = 'bubble-downed';
    const world = flat(seed);
    const downed = createDownedState();
    const dalt = world.addPlayer('p1', 'Dalt', { maxHp: 100 });
    const ren = world.addPlayer('p2', 'Ren', { maxHp: 100 });
    dalt.x = 12;
    dalt.y = 4;
    ren.x = 20;
    ren.y = 20;
    paint(world, 12, 4, TileCode.WATER_FLOOR_BUBBLE);
    const engine = createTurnEngine({ world, now: () => 0, downed });
    engine.join('p1');
    engine.join('p2');
    dalt.hp = 0;
    dalt.alive = false;
    for (let pump = 0; pump < 3; pump += 1) {
      engine.hold('p2');
      engine.pump();
    }
    expect(isDowned(downed, 'p1'), 'precondition: the body is down and ticking').toBe(true);
    expect(world.spendBubble(12, 4)).toBe(chargesFor(seed, 12, 4) - 1);
  });
});

describe('the floor`s level reaches its terrain, through `createRealms`', () => {
  it('resolves each delve floor at its own `base_level + lev - 1`', () => {
    const realms = createRealms({
      seed: 'onstand-realms',
      engineFor: (world) => createTurnEngine({ world }),
    });
    const underworks = need(SITES.get('site:underworks'), 'the underworks');
    const first = realms.open(underworks, 'party-a', undefined, undefined, undefined, 1);
    const second = realms.open(underworks, 'party-a', undefined, undefined, undefined, 2);
    expect(first.baseLevel, 'precondition: a delve with a level').toBeDefined();
    expect(first.world.terrainLevel()).toBe(first.baseLevel);
    expect(second.world.terrainLevel()).toBe(second.baseLevel);
    expect(second.world.terrainLevel()).toBe(first.world.terrainLevel() + 1);
    // Already said, so nobody can say it twice.
    expect(first.world.setTerrainLevel(99)).toBe(false);
    // The overworld has no level, and resolves at upstream's starting one.
    expect(realms.overworld.world.terrainLevel()).toBe(DEFAULT_TERRAIN_LEVEL);
  });
});
