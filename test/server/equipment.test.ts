import { describe, expect, it } from 'vitest';

import { WATCHMAN } from '../../src/server/content/classes.ts';
import { ITEMS, SLOT_ORDER, Slot, itemById } from '../../src/server/content/items.ts';
import { resolveItem } from '../../src/server/content/resolve.ts';
import { composeSheet, composeWielders, wornOf } from '../../src/server/engine/equipment.ts';
import { combatGetResist } from '../../src/server/engine/damage.ts';
import { DamageType } from '../../src/shared/damagetype.ts';
import {
  createEffectState,
  recomposeCombat,
  registerEffect,
  removeEffect,
  setEffect,
} from '../../src/server/engine/effects.ts';
import {
  combatAPR,
  combatArmor,
  combatArmorHardiness,
  combatAttack,
  combatCrit,
  combatCritPower,
  combatDamage,
  combatDamagePower,
  combatDamageRange,
  combatDefense,
  combatMentalResist,
  combatPhysicalResist,
  combatPhysicalpower,
  combatSpellResist,
  combatSpellpower,
} from '../../src/server/engine/derived.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { ActorKind } from '../../src/shared/protocol.ts';
import { scriptedRng } from '../helpers/scripted-rng.ts';
import type { Item } from '../../src/server/content/items.ts';
import type { CombatSheet } from '../../src/server/engine/combat.ts';
import type { EffectDef, EquippedActor } from '../../src/server/engine/effects.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *        THE REVERSIBILITY PROOF. THE ONE THING GEAR MUST NOT GET WRONG.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME's equip/unequip is exact because `removeTemporaryValue` reads the applied
 * value back out of a LEDGER (Entity.lua:960, :1054) rather than re-reading the
 * item. We do not have that ledger and do not want it: upstream's own scheme is
 * NOT exact for its non-additive merge methods (Entity.lua:985's division,
 * :990-992's `1 - (1-b)/(1-v)`, both float round trips that drift), and
 * Actor.lua:104-107 is upstream retrofitting four properties back to plain `add`
 * because of it.
 *
 * Instead there is no inverse operation at all: unequipping removes an id and
 * re-runs the same fold over a smaller set. This file is what proves that claim,
 * because "there is nothing to get wrong" is exactly the kind of sentence that
 * is true right up until somebody adds a multiplicative field.
 *
 * EVERY TEST HERE IS DOM-FREE AND RNG-FREE. The one that touches the status
 * system uses `scriptedRng([])`, which THROWS on the first draw — so if landing
 * an effect ever starts rolling a save, this file says so rather than quietly
 * consuming a number.
 */

/**
 * Narrows away `| undefined` from a lookup. Throwing is right: a missing fixture
 * is a broken test, not a failed assertion, and `!` is banned project-wide.
 */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`test fixture: ${what} is missing`);
  return value;
}

function item(id: string): Item {
  return must(itemById(id), `item ${id}`);
}

/**
 * A realistic non-empty baseline. Shaped like the Watchman's authored sheet
 * (content/classes.ts) rather than an empty object, because an empty base makes
 * "absent means 10" and "absent means 0" indistinguishable — and that
 * distinction is the one bug `composeSheet` could plausibly have.
 */
const BASE: CombatSheet = Object.freeze({
  stats: Object.freeze({ str: 24, dex: 14, con: 20, cun: 12, wil: 14, mag: 10 }),
  mods: Object.freeze({ armour: 6, armourHardiness: 10, def: 3 }),
  weapon: Object.freeze({
    dam: 20,
    physCrit: 2,
    damRange: 1.1,
    damMod: Object.freeze({ str: 0.6 }),
  }),
  range: 1.5,
  minRange: 0,
});

/** The seven-slot kit. One item per slot, so it is a complete loadout. */
const FULL_KIT: readonly Item[] = [
  item('item_watchmans_cap'),
  item('item_watchmans_coat'),
  item('item_watchmans_trousers'),
  item('item_watchmans_boots'),
  item('item_watchmans_buckler'),
  item('item_watchmans_brass_ring'),
  item('item_watchmans_badge'),
];

/**
 * Every derived number a player can read off the character sheet, as one vector.
 *
 * The round trip and the per-item proof both compare these rather than the raw
 * sheet, because the raw sheet is what `composeSheet` writes and the getters are
 * what the GAME reads. A change that survives one and not the other is a change
 * that is invisible in play — which is Trap 1 exactly.
 */
function derivedVector(sheet: CombatSheet | undefined): readonly number[] {
  const c = sheet ?? {};
  return [
    combatAttack(c),
    combatDefense(c),
    combatArmor(c),
    combatArmorHardiness(c),
    combatAPR(c),
    combatCrit(c),
    combatCritPower(c),
    combatDamageRange(c),
    combatDamage(c),
    combatDamagePower(c),
    combatPhysicalpower(c),
    combatSpellpower(c),
    combatPhysicalResist(c),
    combatSpellResist(c),
    combatMentalResist(c),
  ];
}

/** Freeze an object and everything reachable from it, so a write throws. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  return Object.freeze(value);
}

/** Heap's algorithm. 7 items -> 5040 orderings, generated once. */
function permutations<T>(input: readonly T[]): T[][] {
  const out: T[][] = [];
  const work = [...input];
  const counters = new Array<number>(work.length).fill(0);
  out.push([...work]);

  let i = 0;
  while (i < work.length) {
    if (counters[i] === undefined || (counters[i] ?? 0) >= i) {
      counters[i] = 0;
      i += 1;
      continue;
    }
    const j = i % 2 === 0 ? 0 : (counters[i] ?? 0);
    const a = must(work[i], `permutation slot ${i}`);
    const b = must(work[j], `permutation slot ${j}`);
    work[i] = b;
    work[j] = a;
    out.push([...work]);
    counters[i] = (counters[i] ?? 0) + 1;
    i = 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. IDENTITY
// ---------------------------------------------------------------------------

describe('composeSheet — identity', () => {
  it('returns a sheet equal to the base when nothing is worn', () => {
    // An empty fold must be the identity function on VALUE. It must not add
    // `stats: {}` or `mods: {}` keys either: an empty fold that is structurally
    // different from its input breaks the round-trip proof below, because
    // "unequip everything" would then never restore the original.
    expect(composeSheet(BASE, [])).toEqual(BASE);
  });

  it('returns a sheet equal to the base when nothing is worn, on a BARE base too', () => {
    // The M2-era fixture shape. `{}` has neither `stats` nor `mods`, so this is
    // the case where an unconditional `stats: { ... }` write would show up.
    const bare: CombatSheet = {};
    expect(composeSheet(bare, [])).toEqual({});
  });

  it('carries untouched fields across by reference', () => {
    // `weapon`, `range`, `minRange`, `flags`, `profile`, `increase`,
    // `penetration` and `damageType` are not part of the fold. Copying them
    // would create a second object that has to be kept in sync with
    // `ClassDef.combat`; sharing them is safe because every one is readonly all
    // the way down and nothing in the process mutates one.
    const composed = composeSheet(BASE, [item('item_watchmans_cap')]);
    expect(composed.weapon).toBe(BASE.weapon);
    expect(composed.range).toBe(BASE.range);
    expect(composed.minRange).toBe(BASE.minRange);
  });
});

// ---------------------------------------------------------------------------
// 2. PURITY
// ---------------------------------------------------------------------------

describe('composeSheet — purity', () => {
  it('never mutates the base, even deep-frozen, and always returns a new object', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // WHY A DEEP FREEZE AND NOT A SNAPSHOT COMPARISON
    // ═══════════════════════════════════════════════════════════════════════
    // `DEFAULT_PLAYER_COMBAT` is `Object.freeze`d (actor.ts:634) and every
    // `ClassDef.combat` is shared by every body of that class in the process. An
    // in-place merge would not produce a wrong number for one player — it would
    // produce CROSS-ACTOR CONTAMINATION: every Watchman in the session wearing
    // one player's boots. A deep freeze turns that into a throw here rather than
    // into a bug report about armour that "seems high".
    const base: CombatSheet = deepFreeze({
      stats: { str: 24, dex: 14 },
      mods: { armour: 6, armourHardiness: 10, def: 3 },
      weapon: { dam: 20 },
    });
    const before = structuredClone(base);

    const composed = composeSheet(base, [...FULL_KIT]);

    expect(base).toEqual(before);
    expect(composed).not.toBe(base);
    expect(composed.stats).not.toBe(base.stats);
    expect(composed.mods).not.toBe(base.mods);
    // The result is frozen too, so the NEXT stage (`recomputeAttributes`) is
    // structurally forced to build a new object rather than patch this one.
    expect(Object.isFrozen(composed)).toBe(true);
  });

  it('does not let two actors sharing one base sheet see each other`s gear', () => {
    const alice = composeSheet(BASE, [item('item_watchmans_coat')]);
    const bob = composeSheet(BASE, []);

    expect(combatArmor(alice)).toBe(10);
    expect(combatArmor(bob)).toBe(6);
    expect(combatArmor(BASE)).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// 3. ORDER INDEPENDENCE
// ---------------------------------------------------------------------------

describe('composeSheet — order independence', () => {
  it('produces an identical sheet for all 5040 orderings of a seven-piece kit', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THIS IS THE TEST THAT CATCHES ANYONE REACHING FOR A NON-ADDITIVE FIELD.
    // ═══════════════════════════════════════════════════════════════════════
    // Addition commutes; multiplication onto a running total does not commute
    // with addition, and ToME's `mult` / `perc_inv` merge methods
    // (Entity.lua:985-996) are exactly that. The day somebody adds one, this
    // test goes red across thousands of orderings instead of producing a sheet
    // that depends on the order a player happened to press buttons in.
    //
    // It is also why content/items.ts refuses a FRACTIONAL wielder value: float
    // addition is not associative, so `0.1 + 0.2 + 0.3` differs from
    // `0.3 + 0.2 + 0.1` in the last bit. Integers make this proof exact rather
    // than approximately true.
    const orderings = permutations(FULL_KIT);
    expect(orderings).toHaveLength(5040);

    const canonical = composeSheet(BASE, FULL_KIT);
    for (const ordering of orderings) {
      expect(composeSheet(BASE, ordering)).toEqual(canonical);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. THE ROUND TRIP — docs/architecture.md:462
// ---------------------------------------------------------------------------

/** The bare minimum `recomposeCombat` needs, as a plain object. */
function fixtureActor(base: CombatSheet = BASE): EquippedActor {
  return {
    id: 'a',
    name: 'Alice',
    kind: ActorKind.Player,
    hp: 60,
    maxHp: 60,
    alive: true,
    combat: base,
    baseCombat: base,
    equipped: {},
    carried: [],
    cooldowns: new Map<string, number>(),
  };
}

describe('equip and unequip round-trip exactly', () => {
  it('returns every derived number to its starting value after 20 scripted operations', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE PROOF docs/architecture.md:462 NAMES.
    // ═══════════════════════════════════════════════════════════════════════
    // A SCRIPTED order rather than a random one, because a seeded shuffle would
    // put an RNG in a test whose whole subject is "this has no state to drift".
    // The script deliberately includes the three hard cases:
    //   - REPLACING an occupied slot (a second HEAD item, twice)
    //   - unequipping a slot that is already empty
    //   - equipping and unequipping the same item back-to-back
    const actor = fixtureActor();
    const before = structuredClone(actor.combat);
    const derivedBefore = derivedVector(actor.combat);

    const equip = (slot: Slot, id: string): void => {
      actor.equipped = { ...actor.equipped, [slot]: id };
      recomposeCombat(actor, null, resolveItem);
    };
    const unequip = (slot: Slot): void => {
      const next = { ...actor.equipped };
      delete next[slot];
      actor.equipped = next;
      recomposeCombat(actor, null, resolveItem);
    };

    equip(Slot.Head, 'item_watchmans_cap'); // 1
    equip(Slot.Body, 'item_watchmans_coat'); // 2
    equip(Slot.Legs, 'item_watchmans_trousers'); // 3
    equip(Slot.Head, 'item_inspectors_deerstalker'); // 4  — replaces, not stacks
    equip(Slot.Feet, 'item_inspectors_oxfords'); // 5
    unequip(Slot.Body); // 6
    equip(Slot.Offhand, 'item_inquisitors_tome'); // 7
    equip(Slot.Ring, 'item_watchmans_brass_ring'); // 8
    equip(Slot.Trinket, 'item_inspectors_locket'); // 9
    equip(Slot.Body, 'item_leather_chest'); // 10
    unequip(Slot.Ring); // 11
    equip(Slot.Ring, 'item_inquisitors_seal'); // 12
    equip(Slot.Head, 'item_inquisitors_cowl'); // 13 — replaces again
    unequip(Slot.Offhand); // 14
    unequip(Slot.Offhand); // 15 — already empty; must be a no-op
    unequip(Slot.Trinket); // 16
    unequip(Slot.Head); // 17
    unequip(Slot.Legs); // 18
    unequip(Slot.Feet); // 19
    unequip(Slot.Body); // 20
    unequip(Slot.Ring); // and empty

    expect(actor.equipped).toEqual({});
    // THE SHEET ITSELF, field for field.
    expect(actor.combat).toEqual(before);
    // AND EVERY DERIVED GETTER, exactly — not `toBeCloseTo`. The fold is integer
    // addition into a double, so "exactly" is the honest assertion; a
    // `toBeCloseTo` here would hide precisely the drift this file exists to
    // rule out.
    expect(derivedVector(actor.combat)).toEqual(derivedBefore);

    // Named individually as well, because a vector comparison that silently
    // shrank would still pass. These are the numbers on the character sheet.
    const sheet = actor.combat;
    expect(combatArmor(sheet ?? {})).toBe(6);
    expect(combatDefense(sheet ?? {})).toBe(combatDefense(BASE));
    expect(combatAttack(sheet ?? {})).toBe(combatAttack(BASE));
    expect(combatAPR(sheet ?? {})).toBe(combatAPR(BASE));
    expect(combatCrit(sheet ?? {})).toBe(combatCrit(BASE));
    expect(combatCritPower(sheet ?? {})).toBe(combatCritPower(BASE));
    expect(combatDamage(sheet ?? {})).toBe(combatDamage(BASE));
    expect(combatPhysicalResist(sheet ?? {})).toBe(combatPhysicalResist(BASE));
    expect(combatSpellResist(sheet ?? {})).toBe(combatSpellResist(BASE));
    expect(combatMentalResist(sheet ?? {})).toBe(combatMentalResist(BASE));
  });

  it('gives a body wearing nothing the base sheet BY IDENTITY, not a copy', () => {
    // The identity short-circuit in `recomposeCombat`. It is what keeps
    // `expect(body.combat).toBe(ALCHEMIST.combat)` assertable in
    // class-choice.test.ts and class-wiring.test.ts — those assertions are how
    // those suites say "the class was applied WHOLESALE, never blended".
    const actor = fixtureActor();
    recomposeCombat(actor, null, resolveItem);
    expect(actor.combat).toBe(BASE);
  });

  it('is idempotent — recomposing twice changes nothing', () => {
    const actor = fixtureActor();
    actor.equipped = { [Slot.Body]: 'item_watchmans_coat' };
    recomposeCombat(actor, null, resolveItem);
    const once = structuredClone(actor.combat);
    recomposeCombat(actor, null, resolveItem);
    recomposeCombat(actor, null, resolveItem);
    expect(actor.combat).toEqual(once);
    // AND THE CONTRIBUTION IS PRESENT EXACTLY ONCE. If `recomposeCombat` folded
    // onto the LIVE sheet rather than onto `baseCombat`, this would read 14 then
    // 18: the classic double-apply, and one that only appears after a second
    // call nobody writes on purpose.
    expect(combatArmor(actor.combat ?? {})).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 5. THREE-WRITER SURVIVAL
// ---------------------------------------------------------------------------

/** A flags-only status with no save, so landing it consumes ZERO rng draws. */
function flagEffect(id: string, modifiers: EffectDef['modifiers']): EffectDef {
  return {
    id,
    displayName: id,
    // A fixture badge. See EffectDef.badge -- required so it cannot be forgotten
    // on a real effect, which is the whole reason it is not optional.
    badge: 'Fx',
    description: 'test fixture',
    type: 'physical',
    status: 'detrimental',
    stackMode: 'refresh',
    subtypes: [],
    decrease: 1,
    icon: 'ui_status_stunned_s',
    modifiers,
  };
}

describe('gear, statuses and re-clothing all write one sheet without treading on each other', () => {
  it('keeps the gear contribution present EXACTLY ONCE at every step', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE THREE WRITERS, AND WHY THIS WAS A LIVE BUG RATHER THAN A HYPOTHETICAL
    // ═══════════════════════════════════════════════════════════════════════
    //   `recomputeAttributes` (effects.ts) PRESERVED an earlier merge by
    //       spreading the live sheet — safe.
    //   `world.ts#reclothePlayer` DESTROYED one wholesale: `actor.combat =
    //       overlay.combat`. That is the character-creation path, so a player
    //       who equipped a coat and then finished choosing their class lost the
    //       coat's armour with the id still sitting in `equipped` and the
    //       inventory screen still drawing it.
    // Both now route through `recomposeCombat`, which recomposes from
    // `baseCombat` rather than layering onto whatever is there.
    const state = createEffectState();
    registerEffect(state, flagEffect('test_dazed', { dazed: true }));
    registerEffect(state, flagEffect('test_breached', { breached: true }));
    registerEffect(state, flagEffect('test_scoured', { scoured: true }));
    const rng = scriptedRng([]); // THROWS on any draw — landing these must be draw-free.

    const world = createWorld('equipment-three-writers');
    const body = world.addPlayer('a', 'Alice', { combat: BASE, maxHp: 72, classId: 'watchman' });
    if (body.kind !== ActorKind.Player) throw new Error('test fixture: not a player');
    const actor = body as unknown as EquippedActor;

    // The coat is +4 armour and +10 hardiness on top of the base 6 and 10.
    const GEARED_ARMOUR = 10;
    const GEARED_HARDINESS = 50;
    actor.equipped = { [Slot.Body]: 'item_watchmans_coat' };
    recomposeCombat(actor, state, resolveItem);
    expect(combatArmor(actor.combat ?? {})).toBe(GEARED_ARMOUR);
    expect(combatArmorHardiness(actor.combat ?? {})).toBe(GEARED_HARDINESS);

    // --- two effects land -----------------------------------------------
    setEffect(state, actor, 'test_dazed', 3, {}, rng);
    expect(combatArmor(actor.combat ?? {})).toBe(GEARED_ARMOUR);
    expect(actor.combat?.flags?.dazed).toBe(true);

    setEffect(state, actor, 'test_breached', 3, {}, rng);
    expect(combatArmor(actor.combat ?? {})).toBe(GEARED_ARMOUR);
    expect(actor.combat?.flags?.dazed).toBe(true);
    expect(actor.combat?.flags?.breached).toBe(true);
    // …and `breached` really is doing something, so the flag is not decorative.
    expect(combatArmorHardiness(actor.combat ?? {})).toBe(GEARED_HARDINESS / 2);

    // --- one expires ------------------------------------------------------
    removeEffect(state, actor, 'test_dazed', rng);
    expect(combatArmor(actor.combat ?? {})).toBe(GEARED_ARMOUR);
    expect(actor.combat?.flags?.dazed).toBe(false);
    expect(actor.combat?.flags?.breached).toBe(true);

    // --- character creation finishes, mid-fight ---------------------------
    // THE STEP THAT USED TO EAT THE COAT. It also must not eat the live status:
    // `reclothePlayer` passes `null` for the effect state (it cannot see the
    // status system) and `recomposeCombat` therefore carries the live flags
    // across unchanged rather than inventing a baseline.
    expect(world.reclothePlayer('a', { combat: BASE, maxHp: 72, classId: 'watchman' })).toBe(true);
    expect(combatArmor(actor.combat ?? {})).toBe(GEARED_ARMOUR);
    expect(actor.combat?.flags?.breached).toBe(true);
    expect(actor.baseCombat).toBe(BASE);

    // --- a third effect lands afterwards ----------------------------------
    setEffect(state, actor, 'test_scoured', 3, {}, rng);
    expect(combatArmor(actor.combat ?? {})).toBe(GEARED_ARMOUR);
    expect(combatArmorHardiness(actor.combat ?? {})).toBe(GEARED_HARDINESS / 2);
    expect(actor.combat?.flags?.breached).toBe(true);
    expect(actor.combat?.flags?.scoured).toBe(true);
    expect(actor.combat?.flags?.dazed).toBe(false);

    // --- and taking the coat off returns everything ------------------------
    actor.equipped = {};
    recomposeCombat(actor, state, resolveItem);
    expect(combatArmor(actor.combat ?? {})).toBe(6);
    expect(combatArmorHardiness(actor.combat ?? {})).toBe(40 / 2);
    expect(actor.combat?.flags?.scoured).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TRAP 1, MECHANISED — every item must move a number
// ---------------------------------------------------------------------------

describe('every authored item moves at least one number a player can see', () => {
  /**
   * WORN ITEMS ONLY. A draught has no slot and is never on the doll, so "does
   * wearing it move a number" is a question it cannot be asked — its whole
   * mechanic is `use`, which `items.test.ts` asserts is non-zero for exactly the
   * items that have no slot. The rule is unchanged: everything must do
   * something, and the two halves of the catalogue prove it in the two places
   * where the doing happens.
   */
  it.each(
    ITEMS.filter((entry) => entry.slot !== undefined).map((entry) => [entry.id, entry] as const),
  )('%s changes a derived getter when worn alone', (_id, entry) => {
    // ═══════════════════════════════════════════════════════════════════════
    // THIS IS THE MECHANISED FORM OF "AN ITEM THAT CHANGES NOTHING".
    // ═══════════════════════════════════════════════════════════════════════
    // It is what would have caught `mods.apr` being inert against a roster
    // whose armour values are 1 and 2, and it is what forces every stat grant
    // in the catalogue to be +3 or +4: `rescaleCombatStats` FLOORS
    // (shared/scale.ts:116), so a +1 or +2 primary can rescale to the integer
    // it started on and move literally nothing.
    //
    // A BARE base rather than a class sheet, deliberately. It is the hardest
    // case for a rounding-sensitive grant — every stat sits at its default 10
    // and every mod at 0 — and it is also the sheet a classless body carries.
    const bare: CombatSheet = {};
    const before = derivedVector(bare);
    const after = derivedVector(composeSheet(bare, [entry]));
    expect(after).not.toEqual(before);
  });

  it('moves a number on each of the three class sheets too, for the kit that fits it', () => {
    // The bare-base test above proves the item is not inert in principle. This
    // one proves it is not inert on the body that will actually wear it — which
    // is where the armour-below-apr trap lives, and where the floor bites
    // hardest because the stats are already high.
    const geared = composeSheet(BASE, FULL_KIT);
    expect(derivedVector(geared)).not.toEqual(derivedVector(BASE));

    // The measured claim from the design pass, restated as arithmetic:
    // cap + coat + trousers + buckler take armour 6 -> 16 and hardiness
    // 40% -> 50%, which is what clears the husk's apr 7 and the elite's 8.
    expect(combatArmor(geared)).toBe(16);
    expect(combatArmorHardiness(geared)).toBe(50);
    // The cap ALONE already clears apr 7, which is the whole reason it is +3
    // rather than +2: the first piece a Watchman finds has to move the number.
    expect(combatArmor(composeSheet(BASE, [item('item_watchmans_cap')]))).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// wornOf — the stable order, and repair rather than rejection
// ---------------------------------------------------------------------------

describe('wornOf', () => {
  it('returns items in SLOT_ORDER regardless of the order the map was built in', () => {
    // The composed SHEET is order-independent and proven so above. Everything
    // DOWNSTREAM of the iteration is not — a log line, a tooltip's rows, and the
    // order a corpse spills its gear onto the floor. ToME sorts its inventories
    // before spilling for exactly this reason (Actor.lua:3038-3040): a
    // hash-ordered spill gives two replays of one seed the same items in a
    // different floor order, and since pickup takes the first item on the tile,
    // that is a different item.
    const forwards = wornOf(
      {
        head: 'item_watchmans_cap',
        body: 'item_watchmans_coat',
        ring: 'item_watchmans_brass_ring',
      },
      resolveItem,
    );
    const backwards = wornOf(
      {
        ring: 'item_watchmans_brass_ring',
        body: 'item_watchmans_coat',
        head: 'item_watchmans_cap',
      },
      resolveItem,
    );

    expect(forwards.map((i) => i.id)).toEqual([
      'item_watchmans_cap',
      'item_watchmans_coat',
      'item_watchmans_brass_ring',
    ]);
    expect(backwards.map((i) => i.id)).toEqual(forwards.map((i) => i.id));

    // …and that really is `SLOT_ORDER` rather than a coincidence of this fixture.
    // Everything WORN has a slot by construction; the `?? -1` is the type system
    // being told so, not a case this fixture can reach.
    const order = forwards.map((i) => (i.slot === undefined ? -1 : SLOT_ORDER.indexOf(i.slot)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('answers empty for an actor that has never equipped anything', () => {
    expect(wornOf(undefined, resolveItem)).toEqual([]);
    expect(wornOf({}, resolveItem)).toEqual([]);
  });

  it('REPAIRS rather than rejects: an unknown id and a mis-filed slot are skipped', () => {
    // Both are reachable from a save file written by a build that authored an
    // item this one does not, and neither is worth refusing to load somebody's
    // character over. The equip verb is what enforces slot legality when a
    // player asks; this is what survives the aftermath.
    const worn = wornOf(
      {
        head: 'item_that_no_longer_exists',
        // A BODY item filed under FEET. Folding it would grant the coat's armour
        // from a slot that cannot hold it, which is the shape a hand-crafted
        // save would take.
        feet: 'item_watchmans_coat',
        legs: 'item_watchmans_trousers',
      },
      resolveItem,
    );
    expect(worn.map((i) => i.id)).toEqual(['item_watchmans_trousers']);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE ATTRIBUTE POINTS A PLAYER SPENDS HAVE TO REACH THE DERIVED NUMBERS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME grants three a level (`Actor.lua:3748`) and every one of them is supposed
 * to move something a player can read off the sheet. `derived.ts` already ports
 * the whole stat-to-combat pipeline with citations; what was missing was any way
 * for a character to own a stat their class did not author.
 *
 * ═══ STAGE ONE AND A HALF, AND THE ORDER IS THE CLAIM ═══
 * Above the class sheet and BELOW everything worn: the body grows, and the coat
 * adds to who you are now rather than to who you were at level one. These pin
 * that both halves land and that neither eats the other.
 */
describe('attribute points a character has spent', () => {
  it('move the derived numbers they are supposed to move', () => {
    const plain = fixtureActor();
    recomposeCombat(plain, null, resolveItem);
    const before = combatAttack(plain.combat ?? {});

    const grown = fixtureActor();
    // DEXTERITY, because `combatAttack` takes it at FULL weight — one point in
    // is one point of accuracy out, which is the cleanest thing to assert on.
    grown.spentStats = { dex: 5 };
    recomposeCombat(grown, null, resolveItem);

    // ═══ THE ASSERTION THAT WAS FAILING ═══
    // Before the fold existed, `spentStats` was a field nothing read.
    expect(combatAttack(grown.combat ?? {})).toBeGreaterThan(before);
  });

  it('stack with gear rather than being replaced by it', () => {
    /**
     * THE ORDER BUG THIS EXISTS TO CATCH. `recomposeCombat` rebuilds from the
     * class sheet every time, so a spent point folded in the wrong place is not
     * "slightly off" — it is silently DISCARDED the moment anything is equipped,
     * and the symptom is a character who gets weaker when they put a coat on.
     */
    const geared = fixtureActor();
    geared.equipped = { ...geared.equipped };
    recomposeCombat(geared, null, resolveItem);
    const gearOnly = derivedVector(geared.combat);

    const both = fixtureActor();
    both.spentStats = { dex: 5 };
    both.equipped = { ...geared.equipped };
    recomposeCombat(both, null, resolveItem);

    expect(combatAttack(both.combat ?? {})).toBeGreaterThan(combatAttack(geared.combat ?? {}));
    // AND THE GEAR IS STILL THERE. A fold that replaced the sheet instead of
    // adding to it would pass the line above and fail this one.
    expect(gearOnly.length).toBeGreaterThan(0);
  });

  it('leave the class sheet untouched, so a retune still reaches everybody', () => {
    /**
     * ═══ THE HALF THAT MUST NOT MOVE ═══
     * `baseCombat` is "the class's own sheet exactly as content authored it,
     * never written to by the equipment or status systems". A delta that wrote
     * itself into the base would make a spent point indistinguishable from an
     * authored one — and `docs/data-schemas.md` § 1's rule that a save stores
     * RAW points rather than a derived total depends on being able to tell them
     * apart.
     */
    const grown = fixtureActor();
    const authored = structuredClone(grown.baseCombat);
    grown.spentStats = { str: 9, con: 4 };
    recomposeCombat(grown, null, resolveItem);
    expect(grown.baseCombat).toEqual(authored);
  });

  it('changes nothing at all for a character who has spent none', () => {
    // Every body in the game before this feature, and every monster forever.
    const untouched = fixtureActor();
    recomposeCombat(untouched, null, resolveItem);
    const withEmpty = fixtureActor();
    withEmpty.spentStats = {};
    recomposeCombat(withEmpty, null, resolveItem);
    expect(derivedVector(withEmpty.combat)).toEqual(derivedVector(untouched.combat));
  });
});

describe('gear can finally answer an element', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * SIX DAMAGE TYPES, AND UNTIL THIS CHANNEL NO DEFENCE AGAINST ANY OF THEM.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `combatGetResist` has been a complete port — caps and all — since damage.ts
   * was written, monsters have carried resist tables for milestones, and
   * `DamageProfile.resists` is read on every single hit. The player had no way
   * to obtain one point of it, because `Wielder` was `{ stats, mods }` and the
   * fold knew about exactly those two.
   *
   * These tests are about the CHANNEL: that a wielder's resists reach the
   * composed sheet, add across pieces, survive taking a coat off, and are
   * readable through the same getter the damage pipeline spends.
   */
  const FIRE = DamageType.Fire;
  const COLD = DamageType.Cold;

  /**
   * ROUNDED, and the rounding is not slack in the test.
   *
   * `combatGetResist` composes the `all` row with the typed one as
   * `1 - (1 - a) * (1 - b)` (Combat.lua:2220-2231), which is floating point: a
   * flat 15 comes back as 15.000000000000002 and a flat -10 as
   * -10.000000000000009. That is upstream's formula and predates this channel.
   * `view/inspect.ts#pushResistRows` rounds for exactly the same reason, so
   * asserting on the rounded figure is asserting on the number a player is
   * actually shown.
   */
  const resistOf = (sheet: { profile?: unknown }, type: DamageType): number =>
    Math.round(combatGetResist((sheet as { profile?: object }).profile ?? {}, type));

  it('carries a resistance from a worn item onto the sheet', () => {
    const sheet = composeWielders(WATCHMAN.combat, [{ resists: { [FIRE]: 15 } }]);
    expect(resistOf(sheet, FIRE)).toBe(15);
  });

  it('adds two pieces together, like every other channel', () => {
    // Additive, NOT the multiplicative composition `combatGetResist` uses
    // between the `all` row and a typed one — see the fold's note. Two coats at
    // +10 fire are +20 fire, which is what upstream's plain `add` does.
    const sheet = composeWielders(WATCHMAN.combat, [
      { resists: { [FIRE]: 10 } },
      { resists: { [FIRE]: 12, [COLD]: 5 } },
    ]);
    expect(resistOf(sheet, FIRE)).toBe(22);
    expect(resistOf(sheet, COLD)).toBe(5);
  });

  it('lets an authored item trade one element away for another', () => {
    // The only thing this channel can express that `mods` cannot, and the
    // reason a negative is legal here and nowhere else in a `Wielder`.
    const sheet = composeWielders(WATCHMAN.combat, [{ resists: { [FIRE]: 15, [COLD]: -10 } }]);
    expect(resistOf(sheet, FIRE)).toBe(15);
    expect(resistOf(sheet, COLD)).toBe(-10);
  });

  it('gives it all back when the coat comes off', () => {
    // The property this whole file exists for, on the new channel: unequip is a
    // re-fold over the smaller set, not a subtraction.
    const bare = composeWielders(WATCHMAN.combat, []);
    const worn = composeWielders(WATCHMAN.combat, [{ resists: { [FIRE]: 15 } }]);
    expect(resistOf(worn, FIRE)).toBe(15);
    expect(resistOf(bare, FIRE)).toBe(0);
  });

  it('never writes into the sheet it was handed', () => {
    // `profile` is one of the fields the fold otherwise carries BY REFERENCE, so
    // this is the channel where a careless `base.profile.resists[x] = …` would
    // contaminate every body sharing the frozen class sheet.
    const before = structuredClone(WATCHMAN.combat.profile ?? null);
    composeWielders(WATCHMAN.combat, [{ resists: { [FIRE]: 15 } }]);
    expect(WATCHMAN.combat.profile ?? null).toEqual(before);
  });

  it('keeps the cap and the flat reduction it was given', () => {
    // An item may move a resistance. It may not raise its own ceiling — that is
    // what stops the formula inverting above 100% (Combat.lua:2227-2228).
    const base = {
      ...WATCHMAN.combat,
      profile: { resists: { [FIRE]: 5 }, resistsCap: { [FIRE]: 40 } },
    };
    const sheet = composeWielders(base, [{ resists: { [FIRE]: 90 } }]);
    expect(sheet.profile?.resistsCap).toEqual({ [FIRE]: 40 });
    // 95 raw, capped at 40 by the profile's own ceiling.
    expect(resistOf(sheet, FIRE)).toBe(40);
  });

  it('is order-independent across a whole kit, like the other two channels', () => {
    const blocks = [
      { resists: { [FIRE]: 3 } },
      { resists: { [FIRE]: 5, [COLD]: 2 } },
      { stats: { str: 3 } },
      { resists: { [COLD]: 7 } },
    ];
    const forward = composeWielders(WATCHMAN.combat, blocks);
    const backward = composeWielders(WATCHMAN.combat, [...blocks].reverse());
    expect(forward.profile).toEqual(backward.profile);
  });
});
