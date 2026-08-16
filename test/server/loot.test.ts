import { describe, expect, it } from 'vitest';

import { rollDrop, seedTestEncounter } from '../../src/server/content/encounter.ts';
import { ITEMS, SLOT_ORDER } from '../../src/server/content/items.ts';
import {
  INDEX_HUSK,
  INDEX_HUSK_ELITE,
  INDEX_WRAITH,
  MONSTER_TEMPLATES,
  monsterInit,
  validateTemplate,
} from '../../src/server/content/monsters.ts';
import { AiProfile, IntentKind } from '../../src/server/engine/actor.ts';
import { createBarrier } from '../../src/server/engine/barrier.ts';
import { pump, submitIntent } from '../../src/server/engine/scheduler.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { createRng } from '../../src/shared/rng.ts';
import type { CombatSheet } from '../../src/server/engine/combat.ts';
import type { LootResolution } from '../../src/server/engine/scheduler.ts';
import type { Slot } from '../../src/server/content/items.ts';
import type { Actor, World } from '../../src/server/world/world.ts';
import type { Rng } from '../../src/shared/rng.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DROPS: ROLLED AT SPAWN, SPILLED WITHOUT A DRAW, IN AN ORDER THAT IS FIXED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The whole feature is three claims, and every test in this file is one of them:
 *
 *   1. THE DRAWS ARE AT SPAWN, ON `world.lootRng`, AND NOWHERE ELSE. The play
 *      stream is byte-identical to the game before drops existed, which is why
 *      not one of the other 1,517 tests moved when this landed.
 *   2. DEATH TAKES NO DRAW AT ALL. A kill spills an already-decided list. If it
 *      rolled instead, every to-hit, crit, damage and AI draw after a monster
 *      died would shift — in that pump and in every pump for the rest of the
 *      session (src/shared/rng.ts:31-39).
 *   3. THE SPILL ORDER IS SORTED, never a Map's or an object's iteration order.
 *      A pickup takes index 0 of the tile's pile, so a different spill order is
 *      literally a different item picked up — the bug that reads as "the wrong
 *      thing got taken".
 *
 * All three are ported: `resolvers.calc.drops` rolls at ENTITY RESOLUTION
 * (modules/tome/resolvers.lua:427-450, `__resolve_last=true` at :421) and
 * `Actor:die` spills the resolved inventory with no drop-table draw anywhere in
 * it (modules/tome/class/Actor.lua:3011-3060), sorting the inventories first
 * (:3038). The faithful port and the determinism-safe port are the same port.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HUSK_SPRITE = 'enemy_index_husk_s';

/**
 * A weapon that always lands and always rolls the SAME NUMBER.
 *
 * `damRange: 1.0` collapses the damage interval to a point, so damage.ts:276
 * returns before taking a draw; `atk: 100` rescales far past the 100% bound. The
 * same fixture, and the same argument, as `FLAT_SIX` in
 * test/server/progression-award.test.ts: a kill arranged by picking a lucky seed
 * converts a structural property into a coincidence that stops holding the next
 * time anything upstream draws.
 */
const FLAT_SIX: CombatSheet = { weapon: { dam: 20, atk: 100, damRange: 1.0 }, minRange: 0 };

/** The three ids `seedTestEncounter` mints, in the ENCOUNTER array's order. */
const SEEDED_IDS = ['mon_index_husk', 'mon_index_wraith', 'mon_index_husk_elite'] as const;

/**
 * An `Rng` that remembers every draw, wrapping a real one.
 *
 * THE ONLY WAY TO SEE A LABEL THAT IS NOT THE LAST ONE. `RngState.lastLabel`
 * holds exactly one string, so a run that took six draws can only ever be asked
 * about the sixth — and "did the pick draw carry the right label" is a question
 * about the second. Every method delegates, so the numbers are the real
 * generator's and the world under test behaves identically to one that was never
 * wrapped.
 */
type Recorder = Rng & { readonly draws: readonly { readonly label: string }[] };

function recording(inner: Rng): Recorder {
  const draws: { readonly label: string }[] = [];
  return {
    draws,
    nextU32: (label) => {
      draws.push({ label });
      return inner.nextU32(label);
    },
    nextFloat: (label) => {
      draws.push({ label });
      return inner.nextFloat(label);
    },
    int: (label, min, max) => {
      draws.push({ label });
      return inner.int(label, min, max);
    },
    pick: (label, arr) => {
      draws.push({ label });
      return inner.pick(label, arr);
    },
    shuffle: (label, arr) => {
      draws.push({ label });
      return inner.shuffle(label, arr);
    },
    fork: (label) => inner.fork(label),
    getState: () => inner.getState(),
    setState: (next) => {
      inner.setState(next);
    },
  };
}

/**
 * Seed the encounter with the loot stream under observation.
 *
 * `World` is a plain object literal whose methods are closures over the real
 * internals (src/server/world/world.ts), so spreading it and swapping one field
 * produces a facade that mutates the SAME world. Nothing is stubbed: the
 * monsters are really placed, on the real tiles, from the real templates.
 */
function seedWatched(world: World): Recorder {
  const rec = recording(world.lootRng);
  seedTestEncounter({ ...world, lootRng: rec });
  return rec;
}

/** What every seeded monster is carrying, keyed by id, in encounter order. */
function carriedByMonster(world: World): readonly (readonly [string, readonly string[]])[] {
  return SEEDED_IDS.map((id) => [id, world.getActor(id)?.carried ?? []] as const);
}

/** The real loot seam, exactly as `createTurnEngine` supplies it. */
const LOOT: LootResolution = {
  spillOrder: (actor) => {
    const out: string[] = [];
    const seen = new Set<string>();
    const take = (id: string | undefined): void => {
      if (id === undefined || seen.has(id)) return;
      seen.add(id);
      out.push(id);
    };
    const worn = actor.equipped;
    if (worn !== undefined) for (const slot of SLOT_ORDER) take(worn[slot]);
    for (const id of actor.carried ?? []) take(id);
    return out;
  },
};

type Fight = {
  readonly world: World;
  readonly husk: Actor;
  /** One player attack, resolved. */
  readonly swing: (nowMs: number) => void;
};

/**
 * One player adjacent to one husk, wired through the REAL pump with the REAL
 * loot seam. Nothing about the kill path is stubbed — this is `strike` ->
 * `attackTarget` -> `applyDamage` -> `noteCasualty` -> `spillLoot`.
 */
function fight(seed: string, carried: readonly string[], huskHp = 5): Fight {
  const world = createWorld(seed);
  const barrier = createBarrier();

  const p1 = world.addPlayer('p1', 'Ren');
  p1.x = 11;
  p1.y = 2;
  p1.maxHp = 10_000;
  p1.hp = 10_000;
  p1.hpRegen = 0;
  p1.combat = FLAT_SIX;

  const husk = world.addMonster('m1', {
    name: 'Index Husk',
    sprite: HUSK_SPRITE,
    x: 12,
    y: 2,
    profile: AiProfile.MeleeChaser,
    maxHp: huskHp,
  });
  if (carried.length > 0) husk.carried = carried;

  return {
    world,
    husk,
    swing: (nowMs) => {
      expect(submitIntent(world, barrier, 'p1', { kind: IntentKind.Attack, targetId: 'm1' })).toBe(
        true,
      );
      pump(world, { nowMs, barrier, loot: LOOT });
    },
  };
}

// ---------------------------------------------------------------------------
// 1 — DETERMINISM. The headline, and the reason the other 1,517 tests are green.
// ---------------------------------------------------------------------------

describe('the drop roll is deterministic and costs the play stream nothing', () => {
  it('gives two worlds built from the same seed the same three drops', () => {
    const a = createWorld('loot-determinism');
    const b = createWorld('loot-determinism');
    seedTestEncounter(a);
    seedTestEncounter(b);

    expect(carriedByMonster(a)).toEqual(carriedByMonster(b));
    // ...and a different seed really does produce a different floor, or the
    // assertion above would be satisfied by a roll that never rolled.
    const other = createWorld('loot-determinism-other');
    seedTestEncounter(other);
    expect(carriedByMonster(other)).not.toEqual(carriedByMonster(a));
  });

  it('LEAVES `world.rng` BYTE-IDENTICAL TO A FLOOR SEEDED WITH DROPS DISABLED', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE PROOF THAT ZERO EXISTING SEEDED TESTS MOVE.
    // ═══════════════════════════════════════════════════════════════════════
    // `withDrops` runs the shipped `seedTestEncounter`. `withoutDrops` runs the
    // same function minus the roll — the same templates, the same tiles, the
    // same `addMonster` calls, in the same order — which is what
    // `seedTestEncounter` was before this feature landed. If the two play
    // streams ever differ, a drop draw has escaped onto `world.rng` and every
    // seeded combat test in the suite is now reading different numbers.
    const withDrops = createWorld('loot-no-shift');
    seedTestEncounter(withDrops);

    const withoutDrops = createWorld('loot-no-shift');
    for (const [template, at] of [
      [INDEX_HUSK, { x: 22, y: 6 }],
      [INDEX_WRAITH, { x: 25, y: 20 }],
      [INDEX_HUSK_ELITE, { x: 8, y: 24 }],
    ] as const) {
      withoutDrops.addMonster(`mon_${template.id}`, monsterInit(template, at));
    }

    expect(withDrops.rng.getState()).toEqual(withoutDrops.rng.getState());
    // Placement is unmoved too, which is the other stream a careless
    // implementation would have drawn on (`world.spawn.overflow`, world.ts:524).
    expect(SEEDED_IDS.map((id) => withDrops.getActor(id)?.x)).toEqual(
      SEEDED_IDS.map((id) => withoutDrops.getActor(id)?.x),
    );
    // And the loot stream really did move — otherwise this test proves nothing
    // except that a function which does nothing changes nothing.
    expect(withDrops.lootRng.getState().count).toBeGreaterThan(0);
    expect(withoutDrops.lootRng.getState().count).toBe(0);
  });

  it('leaves the play stream at the state a two-fork world would have had', () => {
    // The end-to-end form of the fork argument in src/server/world/world.ts:
    // `fork` does not advance its parent (shared/rng.ts:261-274), so adding
    // `world.loot` cannot have moved `world.turn` by construction.
    const world = createWorld('loot-fork-plumbing');
    seedTestEncounter(world);
    expect(world.rng.getState()).toEqual(
      createRng('loot-fork-plumbing').fork('world.turn').getState(),
    );
  });

  it('never touches the play stream at all — not one draw, not one label', () => {
    const world = createWorld('loot-play-untouched');
    seedTestEncounter(world);
    expect(world.rng.getState().count).toBe(0);
    expect(world.rng.getState().lastLabel).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 2 — THE LABELS, and the stream they are taken on
// ---------------------------------------------------------------------------

describe('the two draw labels', () => {
  it('are exactly `loot.chance` and `loot.pick`, in that order, and nothing else', () => {
    // FROZEN FROM THIS COMMIT. A label cannot change a replay (shared/rng.ts:
    // 31-39) — it is a diagnostic — but it is the only mechanism in the process
    // that can prove a drop draw landed on the generator it was supposed to.
    const world = createWorld('loot-labels');
    const labels = seedWatched(world).draws.map((draw) => draw.label);

    expect(labels.length).toBeGreaterThan(0);
    expect(new Set(labels)).toEqual(new Set(['loot.chance', 'loot.pick']));
    // A pick is only ever reached THROUGH a chance, so the first draw of the
    // whole floor is always a chance roll and a pick never precedes one.
    expect(labels[0]).toBe('loot.chance');
    labels.forEach((label, index) => {
      if (label === 'loot.pick') expect(labels[index - 1]).toBe('loot.chance');
    });
  });

  it('appear on `world.lootRng` and never on `world.rng`', () => {
    const world = createWorld('loot-stream-isolation');
    seedTestEncounter(world);

    expect(world.lootRng.getState().lastLabel).toMatch(/^loot\.(chance|pick)$/);
    expect(world.rng.getState().lastLabel).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 3 — THE DRAW COUNT, which is the part of a seeded stream nothing else guards
// ---------------------------------------------------------------------------

describe('how many draws a drop table costs', () => {
  /** Count the draws one `rollDrop` takes off a throwaway stream. */
  function draws(chance: number | undefined): readonly string[] {
    const rec = recording(createRng('draw-count').fork('world.loot'));
    rollDrop(rec, chance === undefined ? undefined : { chance, pick: ['item_leather_chest'] });
    return rec.draws.map((draw) => draw.label);
  }

  it('costs ZERO draws for a template with no drop table', () => {
    // The pre-drops game, exactly. A roster of dropless monsters leaves the loot
    // stream where it found it, which is what makes `drops` an opt-in field
    // rather than a change to every creature that never asked for one.
    expect(draws(undefined)).toEqual([]);
  });

  it('costs exactly ONE draw at chance 0 — the early return, ported', () => {
    // resolvers.lua:429 `if not rng.percent(t.chance or 100) then return nil end`.
    // The percent roll still happens; the pick does not. Short-circuiting the
    // whole thing to zero draws would be the tidier code and would shift every
    // subsequent drop on that seed.
    expect(draws(0)).toEqual(['loot.chance']);
  });

  it('costs exactly TWO draws at chance 100 — and the chance is still rolled', () => {
    // Guaranteed is not free. Same rule shared/checkhit.ts:108-112 states for
    // the to-hit roll: a short-circuit that skips a decided draw desynchronises
    // every roll after it.
    expect(draws(100)).toEqual(['loot.chance', 'loot.pick']);
  });

  it('costs the shipped floor between three and six draws, and the wraith always two', () => {
    // Three templates, three chance rolls, plus one pick per success. The wraith
    // is `chance: 100`, so at least one pick is guaranteed on every seed.
    const world = createWorld('loot-floor-count');
    const labels = seedWatched(world).draws.map((draw) => draw.label);

    expect(labels.filter((label) => label === 'loot.chance')).toHaveLength(3);
    const picks = labels.filter((label) => label === 'loot.pick').length;
    expect(picks).toBeGreaterThanOrEqual(1);
    expect(picks).toBeLessThanOrEqual(3);
    expect(world.getActor('mon_index_wraith')?.carried).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4 — THE TABLES THEMSELVES
// ---------------------------------------------------------------------------

describe('the three authored drop tables', () => {
  const tierIds = (tier: string): readonly string[] =>
    ITEMS.filter((item) => item.tier === tier).map((item) => item.id);

  it('are the three tiers verbatim — the tier IS the drop table', () => {
    // content/items.ts authored `tier` to be the table, so that adding an item
    // adds it to a monster's loot without a second list having to be edited. If
    // these ever diverge, that promise is broken silently.
    expect(INDEX_HUSK.drops).toEqual({ chance: 35, pick: tierIds('common') });
    expect(INDEX_HUSK_ELITE.drops).toEqual({ chance: 70, pick: tierIds('uncommon') });
    expect(INDEX_WRAITH.drops).toEqual({ chance: 100, pick: tierIds('rare') });
  });

  it('covers all 22 items across the roster — nothing is unreachable', () => {
    // An item that can be worn and can never drop is content that exists only in
    // the catalogue. The three tiers partition the catalogue, so the union of the
    // three tables must be every id.
    const reachable = new Set(MONSTER_TEMPLATES.flatMap((t) => t.drops?.pick ?? []));
    expect([...reachable].sort()).toEqual(ITEMS.map((item) => item.id).sort());
  });

  it('passes validateTemplate on every shipped template', () => {
    for (const template of MONSTER_TEMPLATES) expect(validateTemplate(template)).toEqual([]);
  });

  it('refuses an empty pick, a bad percentage, an unknown id and a duplicate', () => {
    // Each of the four is silent in production: an empty pick throws inside
    // `seedTestEncounter` (which runs at boot AND on every floor reset), an
    // unknown id renders as the violet fallback box on every client, and a
    // duplicate doubles an item's weight while reading as if it had not.
    const base = INDEX_HUSK;
    const withDrops = (drops: NonNullable<typeof base.drops>): typeof base => ({ ...base, drops });

    expect(validateTemplate(withDrops({ chance: 35, pick: [] })).join(' ')).toContain('empty');
    expect(
      validateTemplate(withDrops({ chance: 150, pick: ['item_leather_chest'] })).join(' '),
    ).toContain('drops.chance');
    expect(
      validateTemplate(withDrops({ chance: 35.5, pick: ['item_leather_chest'] })).join(' '),
    ).toContain('drops.chance');
    expect(validateTemplate(withDrops({ chance: 35, pick: ['item_nope'] })).join(' ')).toContain(
      'not in the item catalogue',
    );
    expect(
      validateTemplate(
        withDrops({ chance: 35, pick: ['item_leather_chest', 'item_leather_chest'] }),
      ).join(' '),
    ).toContain('twice');
    // ...and chance 0 is LEGAL. It is how a template says "the table is written,
    // but not yet", and it still takes its one draw.
    expect(validateTemplate(withDrops({ chance: 0, pick: ['item_leather_chest'] }))).toEqual([]);
  });

  it('never equips a monster — every template drops and none wields', () => {
    // `MONSTERS DROP ONLY, THEY NEVER WIELD` (content/monsters.ts). Upstream DOES
    // equip its own npcs (ghoul.lua:124 `resolvers.equip{...}`) but does so
    // INSTEAD of authoring the stats. Every number on our three templates is a
    // cited port of a finished upstream sheet that already has that creature's
    // gear baked in, so layering a `wielder` on top would double-count and would
    // silently falsify every balance figure in that file's 230-line header.
    for (const template of MONSTER_TEMPLATES) {
      const body = createWorld('no-wield').addMonster(
        template.id,
        monsterInit(template, { x: 5, y: 5 }),
      );
      expect(body.equipped).toBeUndefined();
      // The sheet the body carries is the template's, by identity — no fold ran.
      expect(body.combat).toBe(template.combat);
    }
  });
});

// ---------------------------------------------------------------------------
// 5 — THE KILL IS DRAW-FREE. The property the whole design exists to protect.
// ---------------------------------------------------------------------------

describe('killing a monster that is carrying a drop', () => {
  it('TAKES NOT ONE EXTRA DRAW — the play stream is identical either way', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // The formulation matters. "Advanced by exactly the draws combat takes" is
    // only checkable against a control, so the control IS the same kill against
    // the same seed with an empty body: whatever combat costs, both pay it.
    // ═══════════════════════════════════════════════════════════════════════
    const loaded = fight('kill-drawfree', ['item_watchmans_coat']);
    const empty = fight('kill-drawfree', []);

    loaded.swing(0);
    empty.swing(0);

    expect(loaded.husk.alive).toBe(false);
    expect(empty.husk.alive).toBe(false);
    // The whole point: a drop changed nothing about the stream.
    expect(loaded.world.rng.getState()).toEqual(empty.world.rng.getState());
    // ...and the drop really did land, so this is not a test of two empty kills.
    expect(loaded.world.groundItems().map((entry) => entry.itemId)).toEqual([
      'item_watchmans_coat',
    ]);
    expect(empty.world.groundItems()).toEqual([]);
  });

  it('never draws on the loot stream at death — the roll already happened', () => {
    const scene = fight('kill-loot-stream', ['item_watchmans_cap']);
    const before = scene.world.lootRng.getState();
    scene.swing(0);
    expect(scene.world.lootRng.getState()).toEqual(before);
  });

  it('puts the drop on the tile the body fell on', () => {
    const scene = fight('kill-tile', ['item_inspectors_signet']);
    const where = { x: scene.husk.x, y: scene.husk.y };
    scene.swing(0);

    expect(scene.world.itemsAt(where.x, where.y).map((entry) => entry.itemId)).toEqual([
      'item_inspectors_signet',
    ]);
  });

  it('raises one `spilled` event naming the body, the tile and the ids', () => {
    const world = createWorld('kill-event');
    const barrier = createBarrier();
    const p1 = world.addPlayer('p1', 'Ren');
    p1.x = 11;
    p1.y = 2;
    p1.maxHp = 10_000;
    p1.hp = 10_000;
    p1.hpRegen = 0;
    p1.combat = FLAT_SIX;
    const husk = world.addMonster('m1', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: 12,
      y: 2,
      profile: AiProfile.MeleeChaser,
      maxHp: 5,
    });
    husk.carried = ['item_watchmans_boots'];

    expect(submitIntent(world, barrier, 'p1', { kind: IntentKind.Attack, targetId: 'm1' })).toBe(
      true,
    );
    const result = pump(world, { nowMs: 0, barrier, loot: LOOT });

    const spills = result.events.filter((event) => event.t === 'spilled');
    expect(spills).toHaveLength(1);
    expect(spills[0]).toEqual({
      t: 'spilled',
      id: 'm1',
      at: { x: 12, y: 2 },
      itemIds: ['item_watchmans_boots'],
    });
  });

  it('empties the body, so an item never exists on the floor and on a corpse at once', () => {
    const scene = fight('kill-empties', ['item_watchmans_badge']);
    scene.swing(0);
    expect(scene.husk.carried).toEqual([]);
    expect(scene.world.groundItems()).toHaveLength(1);
  });

  it('does nothing at all when no loot seam is wired in — absent is byte-identical', () => {
    // The contract every seam in `PumpCtx` states. With `loot` absent the pump
    // must behave exactly as it did before this feature: no ground item, no
    // event, no field written, and — because the spill is draw-free either way —
    // an identical play stream.
    const world = createWorld('kill-no-seam');
    const barrier = createBarrier();
    const p1 = world.addPlayer('p1', 'Ren');
    p1.x = 11;
    p1.y = 2;
    p1.maxHp = 10_000;
    p1.hp = 10_000;
    p1.hpRegen = 0;
    p1.combat = FLAT_SIX;
    const husk = world.addMonster('m1', {
      name: 'Index Husk',
      sprite: HUSK_SPRITE,
      x: 12,
      y: 2,
      profile: AiProfile.MeleeChaser,
      maxHp: 5,
    });
    husk.carried = ['item_watchmans_coat'];

    expect(submitIntent(world, barrier, 'p1', { kind: IntentKind.Attack, targetId: 'm1' })).toBe(
      true,
    );
    const result = pump(world, { nowMs: 0, barrier });

    expect(husk.alive).toBe(false);
    expect(world.groundItems()).toEqual([]);
    expect(husk.carried).toEqual(['item_watchmans_coat']);
    expect(result.events.some((event) => event.t === 'spilled')).toBe(false);

    const seamed = fight('kill-no-seam', ['item_watchmans_coat']);
    seamed.swing(0);
    expect(world.rng.getState()).toEqual(seamed.world.rng.getState());
  });
});

// ---------------------------------------------------------------------------
// 6 — THE SPILL ORDER
// ---------------------------------------------------------------------------

describe('the spill order is sorted, never an object`s key order', () => {
  /**
   * An `equipped` map built in the WORST order — the reverse of `SLOT_ORDER` —
   * so a spill that walked `Object.keys` would come out backwards and be caught.
   * That is exactly how a real one is built: by whatever order a player pressed
   * buttons in, which differs between two replays of one seed.
   */
  const SCRAMBLED: Partial<Record<Slot, string>> = {
    trinket: 'item_watchmans_badge',
    ring: 'item_watchmans_brass_ring',
    offhand: 'item_watchmans_buckler',
    feet: 'item_watchmans_boots',
    legs: 'item_watchmans_trousers',
    body: 'item_watchmans_coat',
    head: 'item_watchmans_cap',
  };

  it('lays worn gear down in SLOT_ORDER and then the backpack in carry order', () => {
    // Ported from Actor.lua:3036-3040, which sorts the inventories and pushes
    // `INVEN` (the backpack) LAST for exactly this reason. Since `World.itemsAt`
    // hands the pile back in insertion order and a pickup takes index 0, a
    // different spill order is a different item picked up.
    const scene = fight('spill-order', ['item_leather_chest', 'item_inspectors_locket']);
    scene.husk.equipped = { ...SCRAMBLED };
    scene.swing(0);

    expect(scene.world.groundItems().map((entry) => entry.itemId)).toEqual([
      'item_watchmans_cap', // head
      'item_watchmans_coat', // body
      'item_watchmans_trousers', // legs
      'item_watchmans_boots', // feet
      'item_watchmans_buckler', // offhand
      'item_watchmans_brass_ring', // ring
      'item_watchmans_badge', // trinket
      'item_leather_chest', // ...then the backpack, in carry order
      'item_inspectors_locket',
    ]);
  });

  it('produces the identical floor order on every run', () => {
    // The property the sort exists for, stated as a repeat rather than as a
    // shape: two runs of the same fixture must agree tile-for-tile.
    const order = (seed: string): readonly string[] => {
      const scene = fight(seed, ['item_inquisitors_tome', 'item_inquisitors_seal']);
      scene.husk.equipped = { ...SCRAMBLED };
      scene.swing(0);
      return scene.world.groundItems().map((entry) => entry.itemId);
    };
    expect(order('spill-repeat')).toEqual(order('spill-repeat'));
    expect(order('spill-repeat')).toEqual(order('spill-repeat-other'));
  });

  it('spills an id that is both worn and carried exactly once', () => {
    // `carried` is a SET, not a bag — persist/saves.ts's `parseCarried` keeps the
    // first occurrence and drops the rest, and `equipped` wins over `carried` for
    // the same id on load. A body must not be able to leave two of a thing it
    // could only ever have owned one of.
    const scene = fight('spill-dedupe', ['item_watchmans_cap', 'item_watchmans_boots']);
    scene.husk.equipped = { head: 'item_watchmans_cap' };
    scene.swing(0);

    expect(scene.world.groundItems().map((entry) => entry.itemId)).toEqual([
      'item_watchmans_cap',
      'item_watchmans_boots',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 7 — IDEMPOTENCE
// ---------------------------------------------------------------------------

describe('a corpse spills exactly once', () => {
  it('spills nothing on a second lethal blow against a body already down', () => {
    // `killedBy` reads the `killed` flag off the effect rather than re-checking
    // `alive`, and damage.ts:589 returns an EMPTY outcome against something
    // already down — so `killed` is true exactly once per body. That is the same
    // property that stops the reap list double-enrolling and `noteKill`
    // double-paying, and it is what makes the spill idempotent for free.
    const scene = fight('spill-once', ['item_inquisitors_cowl'], 5);
    scene.swing(0);
    expect(scene.world.groundItems()).toHaveLength(1);

    // Swing again at the corpse. It is still in the world — `noteCasualty`
    // ENROLS a dead monster and the caller buries it after the pump returns.
    scene.swing(1);
    expect(scene.world.groundItems()).toHaveLength(1);
  });

  it('spills nothing at all for a monster that was carrying nothing', () => {
    const scene = fight('spill-empty-body', []);
    scene.swing(0);
    expect(scene.husk.alive).toBe(false);
    expect(scene.world.groundItems()).toEqual([]);
  });

  it('does not spill while the body is merely wounded', () => {
    // 23 hp against a flat 6 is four blows. The first three must leave the floor
    // empty, or a drop is a fact about being hit rather than about dying.
    const scene = fight('spill-not-yet', ['item_inspectors_dossier'], 23);
    for (const nowMs of [0, 1, 2]) {
      scene.swing(nowMs);
      expect(scene.world.groundItems()).toEqual([]);
    }
    scene.swing(3);
    expect(scene.world.groundItems()).toHaveLength(1);
  });
});
