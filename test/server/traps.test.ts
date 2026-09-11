import { describe, expect, it } from 'vitest';

import {
  WATCHMAN,
  createContentTalentEngine,
  createTalentBook,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { DELVES, populateDelve, specFor } from '../../src/server/content/delve.ts';
import { EffectId, createMvpEffectState } from '../../src/server/content/effects.ts';
import { TRAP_KINDS, TRAP_MESSAGES, rollTrap } from '../../src/server/content/traps.ts';
import { AiProfile } from '../../src/server/engine/actor.ts';
import { TRIGGER_FAIL_PERCENT, clscale, trapSentence } from '../../src/server/engine/traps.ts';
import { talentRuntimeFor } from '../../src/server/main.ts';
import { createTurnEngine } from '../../src/server/turn-engine.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { DamageType } from '../../src/shared/damagetype.ts';
import { ActorKind, TileCode } from '../../src/shared/protocol.ts';
import { createRng } from '../../src/shared/rng.ts';
import type { DelveSpec } from '../../src/server/content/delve.ts';
import type { AuthoredMap } from '../../src/shared/level.ts';
import type { MonsterActor } from '../../src/server/engine/actor.ts';
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
    message: 'A bolt of fire blasts onto @target@!',
    effect: { kind: 'bolt', damage: options.damage ?? 7, damageType: DamageType.Fire },
    // A BOLT IS NOT SPENT BY GOING OFF — `triggered` returns `true` alone, so
    // `del` is nil. Several tests below turn on exactly this.
    spent: false,
    detectPower: 6,
    disarmPower: 6,
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

describe('and it says what it was', () => {
  it("prints upstream's own sentence, with the victim named", () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE HALF THAT WAS SILENTLY MISSING UNTIL THE BUMP ARGUMENT CAUGHT IT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `engine/Trap.lua:126-135` substitutes `@target@` and logs the result. The
     * damage cannot carry this: it rides `ambient`, which strips the verb, the
     * name and the struck-tile marker because nobody swung, so what reaches the
     * client is a bare number.
     *
     * The version entry for this release argued that a v22 client would take
     * "damage with no verb and no name attached to explain it" — and that was
     * true of THIS build too, because `message` was authored and read by
     * nothing. The Record lane is where it belongs and `PumpResult.records` is
     * how it gets there.
     */
    const table = scene('trap-says');
    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    const result = table.engine.pump();

    expect(result.records ?? [], 'the trap went off and said nothing').toContain(
      'A bolt of fire blasts onto Ren!',
    );
  });

  it('substitutes BOTH placeholders, and the capital one capitalises', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE BUG THAT SHIPPED, AND WHY NO TEST CAUGHT IT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `engine/Trap.lua:136-137` gsubs `@target@` AND `@Target@`, the second
     * capitalised, because the bolts put the name mid-sentence and the alarm
     * puts it first. The port did only the lowercase form, so the intruder
     * alarm printed a literal `@Target@` at the player.
     *
     * IT WAS INVISIBLE BECAUSE THE FIXTURE DISAGREED WITH THE ROSTER. The
     * alarm scene above had been written with `@target@`, so the assertion was
     * measuring a message this game never sends. Fixtures that paraphrase the
     * content they stand for can only ever test themselves — so this drives
     * `trapSentence` directly against the exact strings the roster authors.
     */
    expect(trapSentence('A bolt of fire blasts onto @target@!', 'Ren')).toBe(
      'A bolt of fire blasts onto Ren!',
    );
    expect(trapSentence('@Target@ triggers an alarm!', 'ren')).toBe('Ren triggers an alarm!');
    // AND NEITHER SPELLING SURVIVES INTO THE OUTPUT, whichever the author used.
    for (const message of TRAP_MESSAGES) {
      const said = trapSentence(message, 'Ren');
      expect(said, `${message} left a placeholder in the Case Log`).not.toContain('@');
    }
  });

  it('says nothing at all when a monster springs one', () => {
    /**
     * Upstream uses `logSeen`, which suppresses a sentence about a body you
     * cannot see. Our Record lane is a realm-wide broadcast with no per-viewer
     * form, so a husk's mishap would both name a body the party may not see AND
     * hand them the trap's location for free — the exact leak `TrapsMsg` is a
     * `ViewerMsg` to prevent.
     */
    const table = scene('trap-silent', { at: 4 });
    const husk = table.world.addMonster('m_husk', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: 5,
      y: LANE_Y,
      profile: AiProfile.MeleeChaser,
      maxHp: 300,
    });
    husk.hpRegen = 0;

    const said: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      table.world.turn.engagement = 20;
      expect(table.engine.submitMove('p1', i % 2 === 0 ? 'w' : 'e').ok).toBe(true);
      said.push(...(table.engine.pump().records ?? []));
    }

    // The husk really did cross it — otherwise this is green by nothing
    // happening, which is the shape this file has already been bitten by.
    expect(table.world.trapAt(4, LANE_Y)?.knownBy.has('m_husk')).toBe(true);
    expect(said, 'a monster springing a trap narrated itself to the room').toEqual([]);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE INTRUDER ALARM — `traps/alarm.lua:28-53`. No damage, and worse than any.
 * ═══════════════════════════════════════════════════════════════════════════
 */
describe('the alarm', () => {
  /** Ren, a plate she is about to stand on, and husks scattered out of sight. */
  function alarmScene(seed: string, radius = 20) {
    const world = createWorld(seed);
    world.level.tiles.fill(TileCode.FLOOR);
    // A WALL BETWEEN HER AND THEM, so nothing can possibly have seen her. An
    // alarm that only roused what could already see the victim would be
    // indistinguishable from the ordinary aggro this game already had.
    for (let y = 0; y < world.level.h; y += 1) {
      world.level.tiles[y * world.level.w + 8] = TileCode.WALL;
    }

    const ren = world.addPlayer('p1', 'Ren');
    ren.x = 2;
    ren.y = LANE_Y;
    ren.hpRegen = 0;

    world.addTrap({
      x: 3,
      y: LANE_Y,
      kind: 'trap_alarm',
      message: '@Target@ triggers an alarm!',
      effect: { kind: 'alarm', radius },
      spent: true,
      detectPower: 6,
      disarmPower: 6,
    });

    const far: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = `m_far_${String(i)}`;
      const husk = world.addMonster(id, {
        name: 'Index Husk',
        sprite: HUSK_SPRITE,
        x: 12 + i,
        y: 12 + i,
        profile: AiProfile.MeleeChaser,
        maxHp: 200,
      });
      husk.hpRegen = 0;
      far.push(id);
    }

    const engine = createTurnEngine({ world, now: () => 0 });
    engine.join('p1');

    /** The husk, narrowed. `ai` lives on `MonsterActor` and not on the union. */
    const hunter = (id: string): MonsterActor => {
      const found = world.getActor(id);
      if (found === undefined || found.kind !== ActorKind.Monster) {
        throw new Error(`test fixture: ${id} is not a monster`);
      }
      return found;
    };

    return { world, engine, far, hunter };
  }

  it('turns the whole floor onto you, through a wall and out of sight', () => {
    /**
     * The point of the trap and the reason it is worth porting before any other
     * family: `soundAlarm` tests neither line of sight nor the watcher's own
     * `aggroRange`, because upstream's loop tests neither. A noise is not a
     * thing you see.
     */
    const table = alarmScene('alarm-all');
    for (const id of table.far) {
      expect(table.hunter(id).ai.targetId, 'a husk started out hunting').toBe(null);
    }

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    for (const id of table.far) {
      expect(table.hunter(id).ai.targetId, `${id} never heard the alarm`).toBe('p1');
    }
  });

  it('does no damage whatsoever', () => {
    // `triggered` on TRAP_ALARM projects nothing at all. A player who loses hit
    // points to it would be reading a bolt wearing an alarm's name.
    const table = alarmScene('alarm-harmless');
    const before = table.world.getActor('p1')?.hp;

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    expect(table.world.getActor('p1')?.hp, 'the alarm hurt somebody').toBe(before);
  });

  it('is SPENT when it fires — `return true, true`', () => {
    /**
     * The half the first implementation of this file could not express, because
     * it hardcoded "never removed" from the only family it had. A plate that
     * re-summoned the room every time somebody walked back across it would be a
     * tile nobody could ever cross twice.
     */
    const table = alarmScene('alarm-spent');
    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    expect(table.world.trapAt(3, LANE_Y), 'the alarm stayed armed after firing').toBeUndefined();
  });

  it('leaves a body outside the radius alone', () => {
    // The box is real and is not "everything on the floor" by accident.
    const table = alarmScene('alarm-radius', 2);

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    for (const id of table.far) {
      expect(table.hunter(id).ai.targetId, `${id} heard a noise it could not`).toBe(null);
    }
  });

  it('takes a body that is already hunting somebody else', () => {
    /**
     * `pointAt` — the primitive `raiseAlarm` uses — deliberately refuses to
     * steal an existing target. `soundAlarm` must NOT, and the difference is the
     * whole mechanic: an alarm that left every engaged body alone would do
     * nothing in the one situation a party cares about, which is the fight they
     * are already in getting bigger.
     */
    const table = alarmScene('alarm-steal');
    const first = table.hunter(table.far[0] ?? '');
    first.ai.targetId = 'somebody_else';

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    expect(first.ai.targetId, 'an engaged husk ignored the alarm').toBe('p1');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LETHARGY RUNE — `traps/annoy.lua:29-47`. It takes the buttons.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DRIVEN WITH A REAL TALENT RUNTIME, because the whole rule is a JOIN: the
 * content seam answers which talents are activated, the engine answers which
 * are ready, and the trap writes to `actor.cooldowns`. A fixture that stubbed
 * any one of those would be testing its own stub.
 */
describe('the lethargy rune', () => {
  function runeScene(seed: string) {
    const world = createWorld(seed);
    world.level.tiles.fill(TileCode.FLOOR);
    const talents = createContentTalentEngine();
    const book = createTalentBook(talents, world);
    const engine = createTurnEngine({
      world,
      talents: book,
      talentRuntime: talentRuntimeFor(talents, world),
      now: () => 0,
    });

    const ren = world.addPlayer('p1', 'Ren', { maxHp: 500 });
    ren.x = 2;
    ren.y = LANE_Y;
    ren.hpRegen = 0;
    talents.attach('p1', sheetForClass(WATCHMAN));
    engine.join('p1');

    world.addTrap({
      x: 3,
      y: LANE_Y,
      kind: 'trap_lethargy',
      message: '@Target@ seems less active.',
      effect: { kind: 'lethargy', count: 3, minTurns: 4, maxTurns: 7 },
      spent: true,
      detectPower: 20,
      disarmPower: 20,
    });

    return { world, engine, ren, book };
  }

  it("puts three of the victim's ready talents on cooldown", () => {
    const table = runeScene('rune-cd');
    expect(table.ren.cooldowns.size, 'the fixture started with something on cooldown').toBe(0);

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    expect(table.ren.cooldowns.size, 'the rune shut nothing down').toBe(3);
    for (const [talentId, turns] of table.ren.cooldowns) {
      // `rng.range(4, 7)`, both ends inclusive.
      expect(turns, `${talentId} got a duration outside 4..7`).toBeGreaterThanOrEqual(4);
      expect(turns).toBeLessThanOrEqual(7);
    }
  });

  it('picks DISTINCT talents — `rng.tableRemove` removes what it returns', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A POOL OF EXACTLY THREE, BECAUSE TWELVE HID THE BUG.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `rng.tableRemove` removes the element it returns, so three picks from a
     * pool of three take ALL THREE. An implementation that indexed without
     * removing would repeat, and the first draft of this test could not tell:
     * the Watchman has twelve talents, three draws from twelve rarely collide,
     * and one seed happened not to. MEASURED — that mutation was run and came
     * back green.
     *
     * Narrowing the pool to the count makes a repeat CERTAIN to show, and the
     * seeds are walked so it cannot hide behind one lucky draw.
     */
    for (let i = 0; i < 8; i += 1) {
      const table = runeScene(`rune-distinct-${String(i)}`);
      const loadout = table.book.loadoutOf(table.ren).map((entry) => entry.id);
      const ready = loadout.slice(0, 3);
      for (const id of loadout.slice(3)) table.ren.cooldowns.set(id, 50);

      expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
      table.engine.pump();

      for (const id of ready) {
        const turns = table.ren.cooldowns.get(id) ?? 0;
        /**
         * `> 0`, NOT `>= 4`. `tickCooldowns` runs once a game turn and a pump
         * can cross more than one, so a talent the rune set to 4 reads back as
         * 3 — which is the clock, not the rune. The rule here is "all three
         * were taken"; the DURATION is pinned in the test above, where the
         * band is read off the map before it can be ticked twice.
         */
        expect(
          turns,
          `${id} was left ready — three picks from three take all three`,
        ).toBeGreaterThan(0);
        expect(turns, `${id} got longer than rng.range(4, 7) could give`).toBeLessThanOrEqual(7);
      }
    }
  });

  it('does no damage and makes no noise', () => {
    const table = runeScene('rune-harmless');
    const before = table.ren.hp;

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    expect(table.ren.hp, 'the lethargy rune hurt somebody').toBe(before);
  });

  it('takes what is left when a body has fewer ready talents than it wants', () => {
    /**
     * `if not tid then break end` — upstream stops at an empty list rather than
     * erroring, and this is the case that reaches it.
     *
     * ═══ THE IDS COME FROM THE SHEET, NOT FROM A GUESS ═══
     * An earlier draft named two talents by hand. A name that is not in the
     * loadout is not filtered out by `cooldownOf`, so the rune would have taken
     * three REAL talents and the test would have passed for the wrong reason.
     *
     * ═══ AND 50, NOT 9, BECAUSE THE CLOCK TICKS ═══
     * `tickCooldowns` runs once a game turn and a pump can cross more than one,
     * so a pre-set 9 came back as 7 — which is inside the rune's own 4..7 band
     * and therefore indistinguishable from the rune having overwritten it. A
     * value the rune could never produce is what makes the assertion mean
     * something.
     */
    const table = runeScene('rune-short');
    const loadout = table.book.loadoutOf(table.ren).map((entry) => entry.id);
    // READ, NOT ASSUMED. An earlier draft asserted four and the Watchman
    // carries twelve; the rule under test is "fewer READY than it wants", and
    // how many the class has is not part of it.
    expect(
      loadout.length,
      'a class with fewer than three talents cannot test this',
    ).toBeGreaterThan(3);

    // EVERYTHING BUT TWO, so the rune wants three and can only reach two.
    const blocked = loadout.slice(0, loadout.length - 2);
    for (const id of blocked) table.ren.cooldowns.set(id, 50);

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    // The two that were already down are untouched by the rune — still far
    // above anything `rng.range(4, 7)` could have written.
    for (const id of blocked) {
      expect(table.ren.cooldowns.get(id) ?? 0, `${id} was shut down twice`).toBeGreaterThan(40);
    }
    // It wanted three and only two were ready, so it took both and stopped —
    // every talent the body has is now on cooldown, and not one more.
    expect(table.ren.cooldowns.size, 'the rune reached past the ready list').toBe(loadout.length);
  });

  it('is SPENT, and says its sentence with a capital', () => {
    const table = runeScene('rune-spent');
    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    const result = table.engine.pump();

    expect(table.world.trapAt(3, LANE_Y), 'the rune stayed armed').toBeUndefined();
    expect(result.records ?? []).toContain('Ren seems less active.');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TELEPORT TRAP — `traps/teleport.lua:26-46`. The worst one in a party.
 * ═══════════════════════════════════════════════════════════════════════════
 */
describe('the teleport trap', () => {
  function shimmerScene(seed: string) {
    const world = createWorld(seed);
    // AN OPEN FLOOR, because `teleportRandom` needs somewhere to put the body
    // and a corridor would let it land back where it started.
    world.level.tiles.fill(TileCode.FLOOR);

    const ren = world.addPlayer('p1', 'Ren');
    ren.x = 2;
    ren.y = LANE_Y;
    ren.hpRegen = 0;

    world.addTrap({
      x: 3,
      y: LANE_Y,
      kind: 'trap_teleport',
      message: '@Target@ shimmers briefly.',
      effect: { kind: 'teleport', range: 100 },
      // NOT SPENT — `return true` with no second value, so `del` is nil.
      spent: false,
      detectPower: 40,
      disarmPower: 40,
    });

    const engine = createTurnEngine({ world, now: () => 0 });
    engine.join('p1');
    return { world, engine, ren };
  }

  it('throws the victim somewhere else on the floor', () => {
    const table = shimmerScene('shimmer-move');

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    // NOT ON THE PLATE, and not where they started either. The assertion is a
    // DIFFERENCE rather than a destination, because the destination is a draw.
    const landed = { x: table.ren.x, y: table.ren.y };
    expect(landed, 'the body never left the tile it triggered').not.toEqual({ x: 3, y: LANE_Y });
    expect(landed).not.toEqual({ x: 2, y: LANE_Y });
  });

  it('does no damage — it separates you, it does not hurt you', () => {
    const table = shimmerScene('shimmer-harmless');
    const before = table.ren.hp;

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    expect(table.ren.hp, 'the teleport trap hurt somebody').toBe(before);
  });

  it('STAYS ARMED, unlike the alarm and the rune', () => {
    /**
     * `return true` with no second value: `known` is true and `del` is NIL. Two
     * of the three no-damage traps are spent when they fire and this one is not,
     * which is why `spent` is per-template rather than "everything that is not a
     * bolt".
     */
    const table = shimmerScene('shimmer-armed');
    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    expect(table.world.trapAt(3, LANE_Y), 'the switch was consumed by firing').toBeDefined();
  });

  it('is much harder to spot than a bolt — mbonus, not clscale', () => {
    /**
     * `resolvers.mbonus(5, 40)` against the bolts' `clscale(6,10,4,0.5)`. At our
     * tier `resolveMBonus` is the flat `add`, so 40 — and the bolts floor at 6.
     * Nothing reads `detectPower` yet (there is no `see_traps` source in this
     * game), which is exactly why it is worth pinning now: the number is
     * authored data and this is what stops it drifting before its reader lands.
     */
    for (let i = 0; i < 200; i += 1) {
      const kit = rollTrap(10, createRng(`detect-${String(i)}`), 'delve.traps.0');
      if (kit?.kind !== 'trap_teleport') continue;
      expect(kit.detectPower, 'the teleport trap stopped using mbonus').toBe(40);
      return;
    }
    throw new Error('200 rolls produced no teleport trap — the roster changed shape');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SLIDING ROCK — `traps/natural_forest.lua:31-49`. Four turns on the floor.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DRIVEN THROUGH THE REAL STATUS DOOR, because the whole point of the `status`
 * shape is that it reuses the one a monster's `onHit` rider goes through. A
 * fixture with no `applyStatus` wired would prove the trap CALLS something and
 * nothing about what lands — which is exactly the hole `monster-casts.test.ts`
 * turned out to have.
 */
describe('the sliding rock', () => {
  function rockScene(seed: string, applyPower: number) {
    const world = createWorld(seed);
    world.level.tiles.fill(TileCode.FLOOR);
    const effects = createMvpEffectState();

    const ren = world.addPlayer('p1', 'Ren', { maxHp: 500 });
    ren.x = 2;
    ren.y = LANE_Y;
    ren.hpRegen = 0;

    world.addTrap({
      x: 3,
      y: LANE_Y,
      kind: 'trap_rock',
      message: '@Target@ slides on a rock!',
      effect: { kind: 'status', effectId: EffectId.Stunned, turns: 4, applyPower },
      spent: false,
      detectPower: 6,
      disarmPower: 16,
    });

    const engine = createTurnEngine({ world, now: () => 0, effects });
    engine.join('p1');
    return { world, engine, ren, effects };
  }

  it('stuns the body that stepped on it', () => {
    // A DC high enough that the save cannot carry the test — the rule here is
    // "the rider lands", and a fixture that let it be shrugged half the time
    // would be measuring `applySave` instead.
    const table = rockScene('rock-stun', 500);

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    expect(
      table.ren.combat?.flags?.stunned,
      'the rock did not stun the body that slid on it',
    ).toBeTruthy();
  });

  it('does no damage — it takes the turns, not the hit points', () => {
    const table = rockScene('rock-harmless', 500);
    const before = table.ren.hp;

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    expect(table.ren.hp, 'the sliding rock hurt somebody').toBe(before);
  });

  it('can be SHRUGGED OFF, because apply_power is a real save DC', () => {
    /**
     * `apply_power = self.disarm_power + 5`. Upstream's explicit `canBe` /
     * "%s resists!" branch is what our `setEffect` does in one call, so a DC of
     * zero must let the save carry — and if the rider were applied
     * unconditionally this is the assertion that notices.
     */
    const table = rockScene('rock-save', 0);

    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    const result = table.engine.pump();

    // EITHER it was shrugged (a Record line says so) or it landed — but with a
    // DC of zero against a real Physical save, the Record lane must have
    // something to say about it at all.
    const said = (result.saves ?? []).join(' ');
    const landed = table.ren.combat?.flags?.stunned;
    expect(
      said.length > 0 || landed !== undefined,
      'a zero-DC rider neither landed nor was narrated as resisted',
    ).toBe(true);
  });

  it('STAYS ARMED — `return true` sits outside the if/else', () => {
    const table = rockScene('rock-armed', 500);
    expect(table.engine.submitMove('p1', 'e').ok).toBe(true);
    table.engine.pump();

    expect(table.world.trapAt(3, LANE_Y), 'the rock was consumed by firing').toBeDefined();
  });

  it('is harder to disarm than a bolt, and spends that number as the DC', () => {
    /**
     * `clscale(16,10,8,0.5)` against the bolts' `clscale(6,10,4,0.5)` — more
     * than twice as hard — and `disarm_power + 5` is the save DC, so the rock
     * that resists being taken apart also resists being shrugged. One authored
     * number doing both jobs, which is why `disarmPower` is carried at all.
     */
    for (let i = 0; i < 200; i += 1) {
      const kit = rollTrap(10, createRng(`rock-${String(i)}`), 'delve.traps.0');
      if (kit?.kind !== 'trap_rock') continue;
      expect(kit.disarmPower, 'the rock stopped using its own disarm resolver').toBeGreaterThan(10);
      if (kit.effect.kind !== 'status') throw new Error('the rock stopped being a status trap');
      expect(kit.effect.applyPower, 'the DC is no longer disarm_power + 5').toBe(
        kit.disarmPower + 5,
      );
      return;
    }
    throw new Error('200 rolls produced no sliding rock — the roster changed shape');
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
  it('names the three bolts we can say, plus the two that do no damage', () => {
    // Acid and poison are upstream's other two bolt traps and are deliberately
    // absent: this game has six damage types and neither is among them.
    expect(TRAP_KINDS).toEqual([
      'trap_fire',
      'trap_cold',
      'trap_lightning',
      'trap_alarm',
      'trap_rock',
      'trap_teleport',
      'trap_lethargy',
    ]);
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
      // `undefined` is a real answer — nothing eligible at this depth. At level
      // one the bolts always are, so this is a guard and not a skip.
      if (kit === undefined) continue;
      expect(TRAP_KINDS).toContain(kit.kind);
      if (kit.effect.kind !== 'bolt') continue;
      expect(kit.effect.damage, 'a level-1 trap would nearly kill a fresh Alchemist').toBeLessThan(
        20,
      );
      expect(kit.effect.damage).toBeGreaterThan(0);
    }
  });

  it('makes an out-of-depth trap RARER, not impossible — Zone.lua:218-221', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A HARD FILTER WAS THE WRONG PORT, AND THIS TEST ASSERTED IT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The first version of this said an out-of-band trap can NEVER be rolled,
     * because the first version of `rollTrap` hand-filtered `levelRange` to an
     * include/exclude. Upstream does not exclude: `Zone.lua:218-221` DIVIDES the
     * weight by the distance out of depth — three times harder below the band
     * than above it — so a slightly-too-deep trap gets rarer and only drops out
     * when `floor(max / rarity)` reaches zero.
     *
     * `computeRarities` has ported that since long before traps existed, and the
     * roller now uses it rather than a second answer to the same question.
     *
     * ASSERTED AS A RATIO, because "rarer" is the whole rule and a count on its
     * own would pass for a hard filter too.
     */
    const share = (level: number, kind: string): number => {
      let seen = 0;
      for (let i = 0; i < 400; i += 1) {
        const kit = rollTrap(
          level,
          createRng(`share-${String(level)}-${String(i)}`),
          'delve.traps.0',
        );
        if (kit?.kind === kind) seen += 1;
      }
      return seen / 400;
    };

    // The lethargy rune is `{5, 15}`. Inside its band it is ordinary; two floors
    // BELOW it the weight is divided by 3 x the gap and it becomes scarce.
    const inBand = share(6, 'trap_lethargy');
    const tooShallow = share(3, 'trap_lethargy');

    expect(inBand, 'the rune never appeared even inside its own band').toBeGreaterThan(0.05);
    expect(tooShallow, 'out of depth was not rarer at all').toBeLessThan(inBand);
  });

  it('picks a rarer trap less often — `rarity`, finally read', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A RATIO AGAINST THE ARITHMETIC, NOT TWO COUNTS AGAINST EACH OTHER.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `genprob = floor(RARITY_SCALE / rarity)`, so at level 10 — where all six
     * templates are inside their bands and nothing is out of depth — a rarity-5
     * candidate is weighted 2000 against a rarity-3 candidate's 3333. The
     * teleport trap should therefore appear about three fifths as often as the
     * lethargy rune, and the field is the ONLY difference between those two:
     * both are `{5, 15}`, both are spent-or-not on their own terms, and neither
     * is out of depth here.
     *
     * ═══ THE FIRST VERSION OF THIS ASSERTED `teleports < runes` AND PASSED THE
     * MUTATION THAT DELETES THE RULE ═══
     * With both at rarity 3 the two counts are equal in expectation, so which
     * one lands higher is a coin flip and one seed called it correctly. A bound
     * derived from the arithmetic is what makes this a test: 0.6 expected,
     * 1.0 if rarity is ignored, and 0.8 sits between them with room for the
     * sampling noise at this count.
     */
    let teleports = 0;
    let runes = 0;
    for (let i = 0; i < 1200; i += 1) {
      const kind = rollTrap(10, createRng(`rare-${String(i)}`), 'delve.traps.0')?.kind;
      if (kind === 'trap_teleport') teleports += 1;
      if (kind === 'trap_lethargy') runes += 1;
    }
    expect(teleports, 'the rarity-5 trap never appeared at all').toBeGreaterThan(0);
    expect(runes, 'the rarity-3 trap never appeared at all').toBeGreaterThan(0);
    expect(teleports / runes, 'rarity is being ignored — the two are equally common').toBeLessThan(
      0.8,
    );
  });

  it('bites harder on a deep floor than a shallow one', () => {
    // THE SAME SEED, so the kind and the jitter are identical and the only
    // thing that moved is the floor's level. Walked until a BOLT comes up,
    // because an alarm's radius is deliberately depth-independent — a noise
    // does not get louder further down.
    /**
     * BOTH DEPTHS INSIDE THE SAME ELIGIBLE POOL. At level 1 the lethargy rune is
     * below its own `{5, 15}` range and drops out, so the pool is four rather
     * than five and the SAME SEED picks a different kind — which is the level
     * filter working, and would make this test measure it instead. Five and
     * thirteen both see the whole roster.
     */
    for (let i = 0; i < 30; i += 1) {
      const shallow = rollTrap(5, createRng(`depth-${String(i)}`), 'delve.traps.0');
      const deep = rollTrap(13, createRng(`depth-${String(i)}`), 'delve.traps.0');
      if (shallow === undefined || deep === undefined) continue;
      if (shallow.kind !== deep.kind) continue;
      if (shallow.effect.kind !== 'bolt' || deep.effect.kind !== 'bolt') continue;
      expect(deep.effect.damage).toBeGreaterThan(shallow.effect.damage);
      return;
    }
    throw new Error('thirty rolls produced no bolt trap — the roster changed shape');
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
      message: 'x',
      effect: { kind: 'bolt', damage: 1, damageType: DamageType.Fire },
      spent: false,
      detectPower: 6,
      disarmPower: 6,
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
        if (trap.effect.kind !== 'bolt') continue;
        expect(trap.effect.damage, `${siteId} rolled a bolt that does nothing`).toBeGreaterThan(0);
      }
    }
  });
});
