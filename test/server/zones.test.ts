import { describe, expect, it } from 'vitest';

import { AiProfile } from '../../src/server/engine/actor.ts';
import { DamageType } from '../../src/server/engine/damage.ts';
import { assertZoneSpec, tickZones } from '../../src/server/engine/zones.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { TileCode } from '../../src/shared/protocol.ts';
import { createRng } from '../../src/shared/rng.ts';
import type { ZoneSpec } from '../../src/server/engine/zones.ts';
import type { Actor, World } from '../../src/server/world/world.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FIRE THAT STAYS ON THE FLOOR — `map:addEffect`, Map.lua:1089-1116 and :1231-1254.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```lua
 * for lx, ys in pairs(e.grids) do for ly, _ in pairs(ys) do
 *   local act = game.level.map(lx, ly, engine.Map.ACTOR)
 *   if act and act == e.src and not e.selffire then
 *   elseif act and e.src and (e.src:reactionToward(act) >= 0) and not e.friendlyfire then
 *   else DamageType:get(e.damtype).projector(e.src, lx, ly, e.damtype, e.dam) end
 * end end
 * e.duration = e.duration - 1
 * ```
 *
 * ═══ THE CADENCE IS PINNED THROUGH `engine.pump()`, NOT THROUGH `tickZones` ═══
 * `Game.lua:1737` runs the damage pass on one tick in ten. Ours hangs off
 * `onGameTurn`, and "once per GAME turn" is the assertion that can be wrong:
 * called per pump instead, a four-turn fire would be out before anybody
 * finished a sentence and every unit test of the rule would still pass.
 */

const HUSK_SPRITE = 'enemy_index_husk_s';

type Scene = {
  readonly world: World;
  readonly engine: ReturnType<typeof createTurnEngine>;
  readonly actor: (id: string) => Actor;
};

/** One detective and one husk, far enough apart that neither can reach. */
function scene(seed: string, options: { readonly huskHp?: number } = {}): Scene {
  const world = createWorld(seed);
  world.level.tiles.fill(TileCode.FLOOR);

  const ren = world.addPlayer('p1', 'Ren');
  ren.x = 5;
  ren.y = 5;
  ren.hpRegen = 0;

  const husk = world.addMonster('m_husk', {
    name: 'Index Husk',
    sprite: HUSK_SPRITE,
    x: 20,
    y: 20,
    profile: AiProfile.MeleeChaser,
    maxHp: options.huskHp ?? 200,
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

const FIRE = (over: Partial<ZoneSpec> = {}): ZoneSpec => ({
  srcId: 'p1',
  tiles: [{ x: 20, y: 20 }],
  type: DamageType.Fire,
  damage: 5,
  turns: 3,
  selfFire: false,
  friendlyFire: false,
  ...over,
});

describe('a ground zone burns whoever is standing in it', () => {
  it('hurts a body on one of its tiles, ONCE PER GAME TURN', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE COUNT IS ASKED OF THE CLOCK, NOT ASSUMED FROM THE PUMP.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * One `pump()` is not one game turn — it runs until somebody is parked, and
     * a player's move plus the sweep can cross two boundaries. The first draft
     * of this test asserted a single burn and read ten damage, which is the
     * fixture disagreeing with the assumption rather than the rule being wrong.
     *
     * The CLOCK is read either side, so this pins the RULE: one burn per game
     * turn, however many a single call happens to cover.
     */
    const table = scene('zone-basic');
    table.world.addZone(FIRE({ turns: 9 }));
    const before = table.actor('m_husk').hp;
    const clockBefore = table.world.turn.clock.gameTurn;

    expect(table.engine.submitMove('p1', 'w').ok).toBe(true);
    table.engine.pump();

    const turns = table.world.turn.clock.gameTurn - clockBefore;
    expect(turns, 'the clock did not move at all').toBeGreaterThan(0);
    expect(table.actor('m_husk').hp, 'the floor did not burn once per game turn').toBe(
      before - 5 * turns,
    );
  });

  it('does nothing at all to an empty tile', () => {
    // `local act = ...; if act and ...` — the whole block is gated on somebody
    // being there. A zone is not a list of victims; it is a property of ground.
    const table = scene('zone-empty');
    table.world.addZone(FIRE({ tiles: [{ x: 2, y: 2 }] }));
    const before = table.actor('m_husk').hp;

    expect(table.engine.submitMove('p1', 'w').ok).toBe(true);
    table.engine.pump();

    expect(table.actor('m_husk').hp).toBe(before);
  });

  it('burns out after its duration and is taken off the map', () => {
    const table = scene('zone-expiry');
    table.world.addZone(FIRE({ turns: 2 }));
    const before = table.actor('m_husk').hp;

    // Enough pumps that the clock passes the duration several times over. The
    // assertion is the CEILING: two turns of damage no matter how long we wait.
    for (let i = 0; i < 6; i += 1) {
      expect(table.engine.submitMove('p1', i % 2 === 0 ? 'w' : 'e').ok).toBe(true);
      table.engine.pump();
    }

    expect(table.actor('m_husk').hp, 'the fire kept burning past its duration').toBe(before - 10);
    expect(table.world.zones(), 'the burnt-out zone stayed on the map').toEqual([]);
  });

  it('stops burning a body that walked out, and starts on one that walked in', () => {
    /**
     * The tick asks each tile who is standing on it NOW. Nothing is remembered
     * about who was caught, which is what makes a zone terrain rather than a
     * delayed attack — and the difference a player feels is that stepping out
     * works.
     */
    const table = scene('zone-walk');
    const husk = table.actor('m_husk');
    table.world.addZone(FIRE({ turns: 5 }));

    expect(table.engine.submitMove('p1', 'w').ok).toBe(true);
    table.engine.pump();
    const burnt = table.actor('m_husk').hp;

    husk.x = 25;
    husk.y = 25;
    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();
    expect(table.actor('m_husk').hp, 'a body off the tile was still burnt').toBe(burnt);

    husk.x = 20;
    husk.y = 20;
    expect(table.engine.submitMove('p1', 'w').ok).toBe(true);
    table.engine.pump();
    expect(table.actor('m_husk').hp, 'a body that walked back in was spared').toBe(burnt - 5);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TWO SPARING RULES, WHICH ARE NOT THE SAME RULE TWICE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `selffire` is identity — `act == e.src`. `friendlyfire` is a REACTION —
 * `e.src:reactionToward(act) >= 0` — and that set includes the source. So a
 * zone can spare its caster and still burn their friends, and the first arm is
 * what makes that true rather than an accident of the second.
 */
describe('who a zone spares', () => {
  const rngOf = () => createRng('zone-spare');
  const worldWith = (spec: ZoneSpec, at: { x: number; y: number }) => {
    const world = createWorld('zone-spare');
    world.level.tiles.fill(TileCode.FLOOR);
    const ren = world.addPlayer('p1', 'Ren');
    ren.x = at.x;
    ren.y = at.y;
    ren.hpRegen = 0;
    world.addZone(spec);
    return { world, ren };
  };

  it('spares the caster when selfFire is off, even with friendlyFire ON', () => {
    // The identity arm, on its own. With only the reaction arm this would burn:
    // `reactionToward(self) >= 0` is true, but `friendlyfire` is on.
    const { world, ren } = worldWith(FIRE({ tiles: [{ x: 5, y: 5 }], friendlyFire: true }), {
      x: 5,
      y: 5,
    });
    const before = ren.hp;
    tickZones(world, rngOf());
    expect(ren.hp, 'the caster burnt in their own fire').toBe(before);
  });

  it('STILL spares the caster with selfFire ON but friendlyFire off', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * `selfFire` ON ITS OWN DOES NOTHING, AND THAT IS UPSTREAM'S ARITHMETIC.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The two arms are an `if`/`elseif` over one body. With `selffire` true the
     * FIRST arm does not fire — and the second one catches the caster anyway,
     * because `reactionToward(self) >= 0` is true and `friendlyfire` is off.
     *
     * So `selfFire` is not "burn me": it is "do not exempt me from the friendly
     * rule". A zone only reaches its own caster when BOTH are on. Written down
     * because the first draft of this test asserted the obvious reading, and
     * the obvious reading is wrong in the direction that would have made every
     * player AoE hurt the person who threw it.
     */
    const { world, ren } = worldWith(FIRE({ tiles: [{ x: 5, y: 5 }], selfFire: true }), {
      x: 5,
      y: 5,
    });
    const before = ren.hp;
    tickZones(world, rngOf());
    expect(ren.hp).toBe(before);
  });

  it('burns the caster only when BOTH are on', () => {
    const { world, ren } = worldWith(
      FIRE({ tiles: [{ x: 5, y: 5 }], selfFire: true, friendlyFire: true }),
      { x: 5, y: 5 },
    );
    const before = ren.hp;
    tickZones(world, rngOf());
    expect(ren.hp).toBe(before - 5);
  });

  it('burns EVERYONE once its source has left the world', () => {
    /**
     * THE ONE PLACE THIS PORT GENUINELY DIFFERS FROM UPSTREAM, and it is a
     * consequence of holding an id where upstream holds a live reference.
     * `friendlyFire` is a question about a relationship; with the source gone
     * there is nobody to have one with. The alternative — sparing everybody —
     * would put the fire out in all but name the moment its caster fell, which
     * is exactly when a zone matters most.
     */
    const world = createWorld('zone-orphan');
    world.level.tiles.fill(TileCode.FLOOR);
    const ren = world.addPlayer('p1', 'Ren');
    ren.x = 5;
    ren.y = 5;
    ren.hpRegen = 0;
    world.addZone(FIRE({ srcId: 'somebody_who_left', tiles: [{ x: 5, y: 5 }] }));

    const before = ren.hp;
    tickZones(world, rngOf());
    expect(ren.hp, 'an orphaned zone spared a body it had no relationship with').toBe(before - 5);
  });
});

describe('assertZoneSpec — a zone nobody could read is refused where it is authored', () => {
  it('refuses a damage type outside the six', () => {
    expect(() => assertZoneSpec(FIRE({ type: 'smoke' as DamageType }))).toThrow(/not one of the/);
  });

  it('refuses a zone that would do nothing', () => {
    expect(() => assertZoneSpec(FIRE({ damage: 0 }))).toThrow(/doing nothing/);
    expect(() => assertZoneSpec(FIRE({ turns: 0 }))).toThrow(/whole number of game turns/);
    expect(() => assertZoneSpec(FIRE({ tiles: [] }))).toThrow(/nobody can stand in/);
  });
});
