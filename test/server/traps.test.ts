import { describe, expect, it } from 'vitest';

import { DELVES, populateDelve, specFor } from '../../src/server/content/delve.ts';
import { TRAP_KINDS, rollTrap } from '../../src/server/content/traps.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { TRIGGER_FAIL_PERCENT, clscale } from '../../src/server/engine/traps.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { DamageType } from '../../src/shared/damagetype.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import { createRng } from '../../src/shared/rng.ts';
import type { DelveSpec } from '../../src/server/content/delve.ts';
import type { AuthoredMap } from '../../src/shared/level.ts';
import type { Actor, World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FIFTH MAP LAYER — `engine/Trap.lua:152-155`, raised from `Actor:move`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * function _M:on_move(x, y, who, forced)
 *   if not forced then self:trigger(x, y, who) end
 * end
 * ```
 *
 * Everything here follows from a trap being terrain that acts: it fires on the
 * tile you ARRIVED at, for anybody who walks, and it does not go away.
 */

const HUSK_SPRITE = 'enemy_index_husk_s';
const LANE_Y = 5;

type Scene = {
  readonly world: World;
  readonly engine: ReturnType<typeof createTurnEngine>;
  readonly actor: (id: string) => Actor;
};

/** A corridor with one trap in it, two tiles east of Ren. */
function scene(
  seed: string,
  options: { readonly damage?: number; readonly at?: number } = {},
): Scene {
  const world = createWorld(seed);
  world.level.tiles.fill(TileCode.WALL);
  for (let x = 1; x < 14; x += 1) world.level.tiles[LANE_Y * world.level.w + x] = TileCode.FLOOR;

  const ren = world.addPlayer('p1', 'Ren');
  ren.x = 2;
  ren.y = LANE_Y;
  ren.hpRegen = 0;

  world.addTrap({
    x: options.at ?? 3,
    y: LANE_Y,
    kind: 'trap_fire',
    name: 'fire trap',
    message: 'A bolt of fire blasts onto @target@!',
    damage: options.damage ?? 7,
    damageType: DamageType.Fire,
    detectPower: 6,
  });

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

describe('walking onto a trap', () => {
  it('hurts the body that arrived, and teaches it where the trap is', () => {
    /**
     * BOTH HALVES, because either alone passes for a broken build. Damage with
     * no knowledge is invisible repeating damage a player can never avoid —
     * the trap is not consumed by going off, so "you learn it" IS the whole
     * counterplay for a character with no detection talent.
     */
    const table = scene('trap-step');
    const before = table.actor('p1').hp;

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    expect(table.actor('p1').hp, 'the trap did not go off').toBeLessThan(before);
    expect(table.actor('p1').x, 'the body did not actually arrive on the tile').toBe(3);
    const trap = table.world.trapAt(3, LANE_Y);
    expect(trap?.knownBy.has('p1'), 'the victim was not taught where it was').toBe(true);
  });

  it('is STILL THERE afterwards — an elemental trap is not spent', () => {
    /**
     * `engine/Trap.lua:139-148` — `triggered` returns `true` and nothing else, so
     * `known` is true and `del` is NIL. The trap is removed only when its own
     * effect asks to be. A port that deleted it would turn a permanent hazard
     * into a one-off, which is the difference between a floor you have to read
     * and a floor you walk once.
     */
    const table = scene('trap-persist');
    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    expect(table.world.trapAt(3, LANE_Y), 'the trap was consumed by going off').toBeDefined();
  });

  it('does nothing at all to a body that walks past it', () => {
    // `on_move` fires on the tile you ARRIVED at. A trap is not an aura.
    const table = scene('trap-past', { at: 9 });
    const before = table.actor('p1').hp;

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    expect(table.actor('p1').hp, 'a trap four tiles away went off').toBe(before);
    expect(table.world.trapAt(9, LANE_Y)?.knownBy.size, 'it taught somebody anyway').toBe(0);
  });

  it('goes off again the next time somebody stands on it', () => {
    /**
     * The consequence of not being spent, driven rather than asserted about the
     * table: step on, step off, step back on. `trigger_fail` is 5%, so a single
     * re-entry is overwhelmingly likely to fire — and the assertion is a
     * DIFFERENCE against the first hit rather than a fixed number, so it holds
     * whichever way the two rolls land.
     */
    const table = scene('trap-again');
    const start = table.actor('p1').hp;

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();
    const afterFirst = table.actor('p1').hp;
    expect(afterFirst).toBeLessThan(start);

    expect(table.engine.submitMove('p1', 'w').ok).toBe(true);
    table.engine.pump();
    expect(table.actor('p1').hp, 'stepping OFF a trap hurt').toBe(afterFirst);

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();
    expect(table.actor('p1').hp, 'a trap fired once and then went quiet').toBeLessThan(afterFirst);
  });
});

describe('a monster walks onto one too', () => {
  it('springs the same plate, and the party is told nothing about it', () => {
    /**
     * `on_move` is raised from `engine.Actor.move` and knows nothing about who
     * is moving, so a husk chasing you across its own floor sets off the trap
     * you avoided. That is worth a test because the lane is separate in this
     * engine and a rule wired into only one of them is the recurring shape here.
     *
     * AND ITS KNOWLEDGE IS ITS OWN. `knownBy` is keyed by actor upstream too
     * (`engine/Trap.lua:49`), so a husk learning about a trap tells the party
     * nothing — which is what stops the wire from leaking a tile the player has
     * not paid for.
     */
    const table = scene('trap-husk', { at: 4 });
    const husk = table.world.addMonster('m_husk', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: 5,
      y: LANE_Y,
      profile: AiProfile.MeleeChaser,
      maxHp: 300,
    });
    husk.hpRegen = 0;
    const before = husk.hp;
    table.world.turn.engagement = 20;

    for (let i = 0; i < 4; i += 1) {
      table.world.turn.engagement = 20;
      expect(table.engine.submitMove('p1', i % 2 === 0 ? 'w' : 'e').ok).toBe(true);
      table.engine.pump();
    }

    expect(table.actor('m_husk').hp, 'the husk crossed the plate unharmed').toBeLessThan(before);
    const trap = table.world.trapAt(4, LANE_Y);
    expect(trap?.knownBy.has('m_husk')).toBe(true);
    expect(trap?.knownBy.has('p1'), "the husk's knowledge leaked to the party").toBe(false);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `resolvers.clscale` — AND THE LUA TRUTHINESS TRAP INSIDE IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * math.max(math.ceil((t[1] + rng.range(-t[3],t[3])) * (level/t[2])^t[4]), t[5] or t[1])
 * ```
 *
 * `t[5] or t[1]` reads as "the floor, or the base if none was given", and in
 * Lua ZERO IS TRUTHY — so an explicit `0` really is a floor of zero. Every
 * elemental bolt trap passes one. Read with JavaScript reflexes the floor is
 * the BASE, which would put a 90-damage fire trap on the first floor of the
 * game against a character with 48 hit points.
 */
describe('clscale, and the zero that is not nothing', () => {
  const rng = () => createRng('clscale');

  it('lets an explicit ZERO floor scale a level-1 trap down to single digits', () => {
    // `dam = resolvers.clscale(90, 30, 25, 0.75, 0)` at zone level 1.
    const value = clscale(90, 30, 25, 0.75, 0, 1, rng(), 'dam');
    expect(value, 'the zero floor was read as falsy and fell through to the base').toBeLessThan(20);
    expect(value).toBeGreaterThan(0);
  });

  it('lets an ABSENT floor fall through to the base, which is the other reading', () => {
    /**
     * `detect_power = resolvers.clscale(6,10,4,0.5)` — no fifth argument, so
     * `t[5] or t[1]` really does reach `t[1]`. Both readings are live in the
     * same upstream file, which is why this is a function with a comment rather
     * than four numbers inlined at the call sites.
     */
    expect(clscale(6, 10, 4, 0.5, undefined, 1, rng(), 'detect')).toBe(6);
  });

  it('scales up with the floor, on both sides of the base level', () => {
    const shallow = clscale(90, 30, 0, 0.75, 0, 1, rng(), 'a');
    const deep = clscale(90, 30, 0, 0.75, 0, 30, rng(), 'b');
    expect(deep).toBeGreaterThan(shallow);
    // AT THE BASE LEVEL THE MULTIPLIER IS EXACTLY ONE, which is the only point
    // on the curve where the answer is the authored number and nothing else.
    expect(deep).toBe(90);
  });

  it('takes NO draw when the spread is zero', () => {
    // Mirrors `t[3] and rng.range(...) or 0`, which takes no draw at all with
    // no spread. A draw taken here would shift every later draw from the seed.
    const shared = rng();
    clscale(90, 30, 0, 0.75, 0, 5, shared, 'no-spread');
    const after = shared.int('probe', 1, 1000);
    const fresh = rng();
    expect(after, 'a spread of zero consumed a draw').toBe(fresh.int('probe', 1, 1000));
  });
});

describe('the authored roster', () => {
  it('names three kinds, and every one of them is a damage type we have', () => {
    // Acid and poison are upstream's other two bolt traps and are deliberately
    // absent: this game has six damage types and neither is among them.
    expect(TRAP_KINDS).toEqual(['trap_fire', 'trap_cold', 'trap_lightning']);
  });

  it('rolls a trap a level-1 party can survive', () => {
    /**
     * THE NUMBER THAT MATTERS, checked against the thing it is measured on: the
     * squishiest class in the game starts with 48 hit points
     * (`content/classes.ts`). Upstream's own scaling puts a level-1 bolt trap
     * at single digits, which is a real bite and not a death sentence — and if
     * the `clscale` floor is ever misread it lands at 90 and this fails.
     */
    for (let i = 0; i < 40; i += 1) {
      const kit = rollTrap(1, createRng(`roll-${String(i)}`), 'delve.traps.0');
      expect(kit.damage, 'a level-1 trap would nearly kill a fresh Alchemist').toBeLessThan(20);
      expect(kit.damage).toBeGreaterThan(0);
      expect(TRAP_KINDS).toContain(kit.kind);
    }
  });

  it('bites harder on a deep floor than a shallow one', () => {
    const shallow = rollTrap(1, createRng('depth'), 'delve.traps.0');
    const deep = rollTrap(13, createRng('depth'), 'delve.traps.0');
    // THE SAME SEED, so the kind and the jitter are identical and the only
    // thing that moved is the floor's level.
    expect(deep.kind).toBe(shallow.kind);
    expect(deep.damage).toBeGreaterThan(shallow.damage);
  });
});

describe('trigger_fail — the one escape that applies to everybody', () => {
  it('is five percent, as tome/class/Trap.lua:73 says', () => {
    expect(TRIGGER_FAIL_PERCENT).toBe(5);
  });

  it('spares a body sometimes, and not often', () => {
    /**
     * DRIVEN OVER MANY CROSSINGS rather than asserted about the constant,
     * because the risk is the JOIN: a `>=` where a `>` belongs moves the rate by
     * one point and nothing else in the build would notice.
     *
     * The bounds are wide on purpose. This is a 5% event over 200 trials, so a
     * band of 0-15 misses only by a rate that is wrong by several times — which
     * is exactly the size of error an off-by-one comparison produces, and not
     * the size random variation produces.
     */
    const world = createWorld('trap-fail');
    world.level.tiles.fill(TileCode.FLOOR);
    const ren = world.addPlayer('p1', 'Ren');
    ren.x = 2;
    ren.y = LANE_Y;
    ren.hpRegen = 0;
    ren.maxHp = 100000;
    ren.hp = 100000;
    world.addTrap({
      x: 3,
      y: LANE_Y,
      kind: 'trap_fire',
      name: 'fire trap',
      message: 'x',
      damage: 1,
      damageType: DamageType.Fire,
      detectPower: 6,
    });

    const engine = createTurnEngine({ world, now: () => 0 });
    engine.join('p1');

    let crossings = 0;
    let hp = ren.hp;
    let spared = 0;
    for (let i = 0; i < 200; i += 1) {
      engine.submitMove('p1', i % 2 === 0 ? 'e' : 'w');
      engine.pump();
      if (ren.x !== 3) continue;
      crossings += 1;
      if (ren.hp === hp) spared += 1;
      hp = ren.hp;
    }

    expect(crossings, 'the fixture never actually crossed the trap').toBeGreaterThan(50);
    expect(spared, 'nothing was ever spared — the 5% escape is not wired in').toBeGreaterThan(0);
    expect(spared / crossings, 'far too many crossings were spared').toBeLessThan(0.2);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THEY ACTUALLY REACH A FLOOR SOMEBODY WALKS INTO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every test above drives a hand-placed trap, which proves the RULE and proves
 * nothing about whether a trap is ever generated. This block drives
 * `populateDelve` — the real entry point — because the join between a roster
 * band and a placer is exactly where a system ships wired to nothing.
 */
describe('traps on a generated delve', () => {
  const populate = (siteId: string, seed: string): World => {
    const world = createWorld(seed);
    world.level.tiles.fill(TileCode.FLOOR);
    const map: AuthoredMap = {
      view: world.level,
      spawns: [{ x: 4, y: 4 }],
      sites: new Map<string, string>(),
    };
    const spec = specFor(siteId);
    if (spec === undefined) throw new Error(`no such delve: ${siteId}`);
    populateDelve(world, map, spec);
    return world;
  };

  it('puts them in a worked place', () => {
    const world = populate('site:underworks', 'delve-traps');
    expect(world.traps().length, 'a delve with a traps band generated none').toBeGreaterThan(0);
  });

  it('puts NONE in the gentlest room, which is the Trollmire rule', () => {
    /**
     * `data/zones/trollmire/zone.lua:83` gives ToME's first zone
     * `nb_trap = {0, 0}`. The Drowned Chapel is ours — the room the first case
     * names out loud to a character four minutes old — and it has no band at
     * all, so it takes no draw and generates nothing.
     */
    const world = populate('site:drowned_chapel', 'delve-traps');
    expect(world.traps(), 'the tutorial room was mined').toEqual([]);
  });

  it('generates them SHUT to everybody — nobody starts out knowing', () => {
    // The whole mechanic. A trap that arrived already known would be a trap
    // with no teeth, and `projectTraps` would hand it to the client on join.
    const world = populate('site:gearford_ward', 'delve-traps');
    expect(world.traps().length).toBeGreaterThan(0);
    for (const trap of world.traps()) expect(trap.knownBy.size).toBe(0);
  });

  it('gives every trap a kind the client can draw', () => {
    const world = populate('site:glass_archive', 'delve-traps');
    for (const trap of world.traps()) expect(TRAP_KINDS).toContain(trap.kind);
  });

  it('COSTS THE PARENT STREAM NOTHING, which is what the fork is for', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A COUNTERFACTUAL, BECAUSE THE OBVIOUS TEST IS A TAUTOLOGY.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The first draft populated the same delve twice from one seed and compared
     * the layouts. Identical inputs, identical outputs — it would have passed on
     * any implementation whatsoever, including one that drew from the parent.
     *
     * The real question is whether the trap pass MOVES the stream, and that
     * needs two DIFFERENT runs: the same delve with its band and without it. If
     * traps drew from `world.rng`, the two parents would be at different
     * positions afterwards and every monster, every piece of litter and every
     * lore note in the game would have shifted the day traps landed.
     *
     * `rng.ts` states the property this relies on: `fork` is pure over
     * (state, inc, label) and does not advance its parent.
     */
    const banded = specFor('site:underworks');
    if (banded === undefined) throw new Error('no such delve');
    expect(banded.traps, 'the fixture picked a delve with no band to remove').toBeDefined();

    const after = (spec: DelveSpec): number => {
      const world = createWorld('fork-probe');
      world.level.tiles.fill(TileCode.FLOOR);
      populateDelve(
        world,
        { view: world.level, spawns: [{ x: 4, y: 4 }], sites: new Map<string, string>() },
        spec,
      );
      return world.rng.int('probe', 1, 1_000_000_000);
    };

    const { traps: _dropped, ...trapless } = banded;
    expect(
      after(banded),
      'the trap pass drew from the parent stream and moved every delve in the game',
    ).toBe(after(trapless));
  });

  it('covers every delve in the game without throwing', () => {
    // The bands are authored per site and a typo in one is invisible until
    // somebody walks in. Cheap to walk them all here instead.
    for (const siteId of DELVES.keys()) {
      const world = populate(siteId, `sweep-${siteId}`);
      for (const trap of world.traps()) {
        expect(trap.damage, `${siteId} rolled a trap that does nothing`).toBeGreaterThan(0);
      }
    }
  });
});
