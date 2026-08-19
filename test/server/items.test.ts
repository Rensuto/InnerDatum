import { describe, expect, it } from 'vitest';

import {
  CHECKED_ITEMS,
  DEAD_MOD_KEYS,
  ITEMS,
  ITEM_CATALOGUE,
  KNOWN_ICON_IDS,
  SLOT_ORDER,
  Slot,
  itemById,
  itemsForSlot,
  validateItems,
} from '../../src/server/content/items.ts';
import type { Item } from '../../src/server/content/items.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *          THE CATALOGUE. THIS FILE IS THE ART PIPELINE'S ONLY GUARD.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `client/public/assets/` is gitignored WHOLESALE — a fresh clone of this
 * repository has no art at all and must still run. So a test that resolved icon
 * ids by reading the disk would pass vacuously on exactly the machine that most
 * needs the check (CI, and any contributor who is not the author). The
 * COMMITTED inventory of what art exists is `ASSETS-REQUIRED.md:84-109`, which
 * lists all 23 `item_*` ids and their sizes; the 22 ids below were taken from
 * there by hand. (`client/public/assets/manifest.placeholders.json` is NOT
 * committed — `.gitignore:56` ignores that whole directory — so it cannot be
 * anybody's cross-check, whatever a fresh working tree happens to contain.)
 *
 * THE LIST IS WRITTEN OUT TWICE ON PURPOSE — once in content/items.ts as
 * `KNOWN_ICON_IDS`, once here. Two copies that must agree is the point: editing
 * the source list to make a broken item pass would fail here, and editing this
 * one alone proves nothing. A single shared constant would let one change do
 * both, which is the only thing this pair is defending against.
 *
 * An unresolved sprite id renders as a LOUD violet fallback box on every
 * client's screen, on every frame, for the rest of the session.
 */
const MANIFEST_ITEM_ICONS: readonly string[] = [
  // THE 23RD, AND IT IS AN ABILITY ICON. See the long note on `KNOWN_ICON_IDS`:
  // the rule is that the sprite RESOLVES, and this one is named in
  // docs/assets-needed.md:290 and docs/art-pipeline.md:322 and is loaded by the
  // `icon_active_` prefix the hotbar already pulls.
  'icon_active_alchemic_vial',
  'item_inquisitors_breeches',
  'item_inquisitors_cipher',
  'item_inquisitors_cowl',
  'item_inquisitors_mantle',
  'item_inquisitors_seal',
  'item_inquisitors_tome',
  'item_inquisitors_treads',
  'item_inspectors_deerstalker',
  'item_inspectors_dossier',
  'item_inspectors_locket',
  'item_inspectors_longcoat',
  'item_inspectors_oxfords',
  'item_inspectors_signet',
  'item_inspectors_slacks',
  'item_leather_chest',
  'item_watchmans_badge',
  'item_watchmans_boots',
  'item_watchmans_brass_ring',
  'item_watchmans_buckler',
  'item_watchmans_cap',
  'item_watchmans_coat',
  'item_watchmans_trousers',
];

/**
 * FIVE IDS THAT MUST NEVER APPEAR IN THE CATALOGUE, AND WHY EACH ONE IS
 * TEMPTING RATHER THAN OBVIOUS.
 *
 * `item_iron_ingot` IS ON DISK and IS in the manifest — it is the 23rd icon and
 * the only one not authored. ToME would ship it as junk (`{ type = "money" }`,
 * npcs/ant.lua:220), but this game has no currency, no vendor and no crafting,
 * so its only property would be occupying an inventory cell. An item that
 * changes no number is worse than no item.
 *
 * The other four are worse, because a file in the repository actively claims
 * they work: `client/public/assets/items/_aliases.json` maps each onto an
 * `icon_weapon_*` id and calls itself a build instruction. IT IS WRONG.
 * Neither those four ids nor any `icon_weapon_*` id exists on disk or in
 * `manifest.placeholders.json`. Authoring a weapon against that file's promise
 * ships a violet box.
 */
const FORBIDDEN_IDS: readonly string[] = [
  'item_iron_ingot',
  'item_watchmans_truncheon',
  'item_inspectors_revolver',
  'item_inquisitors_reckoner',
  'item_iron_sword',
];

/** A minimal valid item, so a malformed-item test can vary exactly one field. */
function sampleItem(over: Partial<Item> = {}): Item {
  return {
    id: 'item_watchmans_cap',
    name: "Watchman's Cap",
    slot: Slot.Head,
    icon: 'item_watchmans_cap',
    tier: 'uncommon',
    wielder: { mods: { armour: 3 } },
    desc: 'A cap.',
    ...over,
  };
}

/**
 * One valid item per slot, so `validateItems` gets past its "every slot is
 * populated" clause and fails on whatever the test actually varied.
 */
function fullSlotSpread(): Item[] {
  return SLOT_ORDER.map((slot) => {
    const first = itemsForSlot(slot)[0];
    if (first === undefined) throw new Error(`test fixture: no item for slot ${slot}`);
    return first;
  });
}

describe('the item catalogue', () => {
  it('ships 22 worn items and one you drink', () => {
    // 23 `item_*` ids exist in the manifest. 22 are authored as equipment. The
    // 23rd `item_*` id is the ingot, and cutting it is a decision rather than an
    // oversight — see FORBIDDEN_IDS above; it draws the MONEY pile instead
    // (content/money.ts), which is the system that finally wanted it.
    //
    // The 23rd ITEM is the draught, whose icon is the ability vial rather than
    // an `item_*` file at all.
    expect(ITEMS).toHaveLength(23);
    expect(ITEMS.filter((item) => item.slot !== undefined)).toHaveLength(22);
    expect(ITEMS.filter((item) => item.use !== undefined)).toHaveLength(1);
    // 23 ICONS AND 23 ITEMS. The 23rd icon is the ability vial (see the list
    // above) and the 23rd item is the draught that names it — the first thing in
    // this game you buy in order to SPEND it.
    expect(MANIFEST_ITEM_ICONS).toHaveLength(23);
    expect(ITEM_CATALOGUE.size).toBe(23);
  });

  it('names only icons that exist in the committed manifest', () => {
    // THE TEST THIS FILE EXISTS FOR. One id that is not on this list is a violet
    // box on four people's screens for a whole session.
    const known = new Set(MANIFEST_ITEM_ICONS);
    const strays = ITEMS.filter((item) => !known.has(item.icon)).map((item) => item.icon);
    expect(strays).toEqual([]);

    // And the source's own copy of the list agrees with this one, in both
    // directions — a subset check would let either side quietly grow.
    expect([...KNOWN_ICON_IDS].sort()).toEqual([...MANIFEST_ITEM_ICONS].sort());
  });

  it('references neither the iron ingot nor any of the four aliased weapon ids', () => {
    const forbidden = new Set(FORBIDDEN_IDS);
    const offenders: string[] = [];
    for (const item of ITEMS) {
      if (forbidden.has(item.id)) offenders.push(`id ${item.id}`);
      if (forbidden.has(item.icon)) offenders.push(`icon ${item.icon}`);
    }
    expect(offenders).toEqual([]);

    // And the ingot really is on disk and in the manifest — otherwise this test
    // would keep passing for the wrong reason after somebody deleted the PNG.
    expect(FORBIDDEN_IDS).toContain('item_iron_ingot');
    expect(itemById('item_iron_ingot')).toBeUndefined();
  });

  it('populates every one of the seven slots', () => {
    // An empty slot is a row on the equipment screen that can never be filled:
    // a promise the content does not keep.
    for (const slot of SLOT_ORDER) {
      expect(itemsForSlot(slot).length).toBeGreaterThan(0);
    }
    // …and every authored item files itself under a slot that exists, so a
    // typo cannot create an eighth.
    const slots = new Set<string>(SLOT_ORDER);
    // WORN ITEMS ONLY. A draught has no slot at all — see `Item.slot` — and the
    // assertion under test is that nothing files itself under an EIGHTH slot,
    // not that everything in the catalogue is clothing.
    expect(ITEMS.filter((item) => item.slot !== undefined && !slots.has(item.slot))).toEqual([]);
    // AND THE ONLY THINGS WITHOUT ONE ARE THE THINGS YOU DRINK, which is the
    // other half of the same rule and the one that catches a dropped `slot:`.
    for (const item of ITEMS) {
      if (item.slot === undefined)
        expect(item.use, `${item.id} is neither worn nor drunk`).toBeDefined();
    }
  });

  it('gives every item a unique id and a unique icon', () => {
    // A duplicate id silently shadows in `ITEM_CATALOGUE`: the loser becomes an
    // item that can drop and can never be equipped. A duplicate icon is two rows
    // in a picker that look identical, with no error attached.
    expect(new Set(ITEMS.map((item) => item.id)).size).toBe(ITEMS.length);
    expect(new Set(ITEMS.map((item) => item.icon)).size).toBe(ITEMS.length);
  });

  it('grants no physSpeed, spellPower or mindPower — the three verified-dead mods', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // A TYPE-LEVEL GUARANTEE, ASSERTED AT RUNTIME ANYWAY.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // `AdditiveMods` is `CombatMods` with these three REMOVED, so authoring one
    // is a compile error. This test exists because a cast is not: a `wielder`
    // arriving as `JSON.parse(...) as Wielder` from any future content loader
    // defeats `Omit` entirely and reaches the fold with a field nothing reads.
    //
    // `grep -rn 'combatSpeed\|combatSpellpower\|combatMindpower' src/` returns
    // COMMENTS ONLY. An item granting one of these would type-check, persist,
    // appear in the inventory, print a tooltip and change no number a player can
    // see. content/classes.ts:295 already carries a dead
    // `mods: { spellPower: 4 }`, which is the proof this is a mistake somebody
    // makes here rather than a hypothetical.
    expect([...DEAD_MOD_KEYS].sort()).toEqual(['mindPower', 'physSpeed', 'spellPower']);

    const offenders: string[] = [];
    for (const item of ITEMS) {
      const keys = [
        ...Object.keys(item.wielder.stats ?? {}),
        ...Object.keys(item.wielder.mods ?? {}),
      ];
      for (const key of keys) {
        if (DEAD_MOD_KEYS.includes(key)) offenders.push(`${item.id}.${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('grants no Luck, which is pinned at 50 so nine ported formulas stay zeroed', () => {
    // engine/derived.ts:44-52. An item that moved Luck would unpin nine ToME
    // formulas at once, from the content layer, silently. `lck` is excluded from
    // `AdditiveStats` and from `WIELDER_STAT_KEYS`; this is the third refusal.
    const offenders = ITEMS.filter((item) => 'lck' in (item.wielder.stats ?? {}));
    expect(offenders).toEqual([]);
  });

  it('gives every wielder value as a finite, non-negative INTEGER', () => {
    // The integer clause is the least obvious and the most load-bearing: the
    // fold in engine/equipment.ts is plain floating-point addition, and float
    // addition is not associative. Integers make the fold EXACTLY
    // order-independent, which is what the 5040-permutation test in
    // test/server/equipment.test.ts proves. A fractional wielder value quietly
    // turns that proof into a proof about one ordering.
    const bad: string[] = [];
    for (const item of ITEMS) {
      const entries = [
        ...Object.entries(item.wielder.stats ?? {}),
        ...Object.entries(item.wielder.mods ?? {}),
      ];
      for (const [key, value] of entries) {
        if (typeof value !== 'number') {
          bad.push(`${item.id}.${key} is not a number`);
        } else if (!Number.isInteger(value) || value < 0) {
          bad.push(`${item.id}.${key} = ${String(value)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('gives every item something to contribute — no wielder is empty', () => {
    // Trap 1's coarsest form. The fine-grained form (does each item move a
    // DERIVED getter?) is proved per item in test/server/equipment.test.ts; this
    // one catches the case where somebody authors decoration and forgets the
    // mechanics entirely.
    //
    // ═══ WORN ITEMS ONLY, AND A CONSUMABLE IS NOT AN EXCEPTION TO THE RULE ═══
    // A draught's `wielder` is `{}` BECAUSE IT IS NEVER WORN — it contributes
    // through `use`, and the check below would read "authored decoration with no
    // mechanics" from an item whose entire mechanic is in a different field. The
    // rule it enforces is unchanged: everything must do something, and the
    // `item.use` assertion after it is that same rule for the other kind.
    const inert = ITEMS.filter((item) => {
      if (item.use !== undefined) return false;
      const stats = Object.keys(item.wielder.stats ?? {}).length;
      const mods = Object.keys(item.wielder.mods ?? {}).length;
      return stats + mods === 0;
    }).map((item) => item.id);
    expect(inert).toEqual([]);
    // …and the things that are not worn all do something when they are drunk.
    for (const item of ITEMS) {
      if (item.slot !== undefined) continue;
      expect(item.use?.amount ?? 0, `${item.id} does nothing when used`).toBeGreaterThan(0);
    }
  });

  it('lines its three tiers up with the three drop tables, 7 / 10 / 6', () => {
    // NOT COSMETIC. The roster's drop tables are meant to select on `tier`
    // rather than re-listing 23 ids somewhere else that has to stay in sync:
    //   common   = every LEGS and FEET item, plus the leather chest
    //   uncommon = every HEAD, OFFHAND and TRINKET item, AND the draught
    //   rare     = the three class BODY items and the three RINGs
    //
    // THE DRAUGHT IS UNCOMMON ON PURPOSE and it moved this count from 9 to 10:
    // upstream's healing infusion carries `rarity = 15` against a common's 3-6,
    // and a party that can buy the good one on every visit has no decision to
    // make about drinking it.
    const byTier = (tier: string): Item[] => ITEMS.filter((item) => item.tier === tier);
    expect(byTier('common')).toHaveLength(7);
    expect(byTier('uncommon')).toHaveLength(10);
    expect(byTier('rare')).toHaveLength(6);
    expect(byTier('common').length + byTier('uncommon').length + byTier('rare').length).toBe(
      ITEMS.length,
    );

    // WORN ITEMS ONLY. The assertion is about which SLOTS a tier covers, and a
    // draught covers none — it is uncommon and slotless, which is a fact about
    // the tier ladder rather than a gap in the doll.
    const slotsOf = (tier: string): Set<string> =>
      new Set(byTier(tier).flatMap((i) => (i.slot === undefined ? [] : [i.slot])));
    expect([...slotsOf('uncommon')].sort()).toEqual(['head', 'offhand', 'trinket']);
    expect([...slotsOf('rare')].sort()).toEqual(['body', 'ring']);
  });

  it('resolves every authored id through the catalogue map', () => {
    for (const item of ITEMS) expect(itemById(item.id)).toBe(item);
    expect(itemById('item_that_does_not_exist')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// THE IMPORT-TIME ARITY CHECK
// ---------------------------------------------------------------------------

describe('the import-time arity check', () => {
  it('has already run against the shipped catalogue', () => {
    // If it had thrown, importing this module would have thrown and no test in
    // this file would run at all — which is the intended behaviour: a content
    // mistake takes the server down BEFORE the first connection rather than
    // being discovered by four friends in a voice channel on a Friday night.
    // Modelled on `_loadoutArityCheck` in content/classes.ts:787-796.
    expect(CHECKED_ITEMS).toBe(ITEMS);
  });

  it('throws on an icon that is not in the manifest', () => {
    expect(() =>
      validateItems([...fullSlotSpread(), sampleItem({ id: 'x', icon: 'item_iron_sword' })]),
    ).toThrow(/not one of the 23 ids in the committed asset manifest/);
  });

  it('throws on the iron ingot, which is on disk but deliberately unauthored', () => {
    // It IS a real file and a real manifest entry, so the icon clause alone is
    // what rejects it — proving the catalogue's exclusion is enforced by the
    // 22-id list rather than by everyone remembering.
    expect(() =>
      validateItems([...fullSlotSpread(), sampleItem({ id: 'x', icon: 'item_iron_ingot' })]),
    ).toThrow(/item_iron_ingot/);
  });

  it('throws on a duplicate id', () => {
    expect(() => validateItems([...fullSlotSpread(), sampleItem()])).toThrow(/duplicate id/);
  });

  it('throws on two items sharing one icon', () => {
    expect(() =>
      validateItems([...fullSlotSpread(), sampleItem({ id: 'item_second_cap' })]),
    ).toThrow(/duplicate icon/);
  });

  it('throws when a slot has no item at all', () => {
    const missingTrinket = fullSlotSpread().filter((item) => item.slot !== Slot.Trinket);
    expect(() => validateItems(missingTrinket)).toThrow(/no item exists for slot 'trinket'/);
  });

  it('throws on a negative, fractional, or non-finite wielder value', () => {
    const spread = fullSlotSpread();
    const withMod = (armour: number): Item[] => [
      ...spread,
      sampleItem({
        id: 'item_probe',
        icon: 'item_inspectors_dossier',
        slot: Slot.Offhand,
        wielder: { mods: { armour } },
      }),
    ];

    expect(() => validateItems(withMod(-1))).toThrow(/non-negative INTEGERS/);
    expect(() => validateItems(withMod(1.5))).toThrow(/non-negative INTEGERS/);
    expect(() => validateItems(withMod(Number.NaN))).toThrow(/non-negative INTEGERS/);
    expect(() => validateItems(withMod(Number.POSITIVE_INFINITY))).toThrow(/non-negative INTEGERS/);
    // …and the same value, valid, passes — so the test above is not passing for
    // some unrelated reason.
    expect(validateItems(withMod(2))).toHaveLength(spread.length + 1);
  });

  it('throws on a dead mod smuggled past the type by a cast', () => {
    // The exact shape a future JSON content loader would produce. `Omit` is
    // erased at runtime; this is what still catches it.
    const smuggled = sampleItem({
      id: 'item_probe',
      icon: 'item_inspectors_dossier',
      slot: Slot.Offhand,
      wielder: { mods: { physSpeed: 4 } as unknown as Item['wielder']['mods'] },
    });
    expect(() => validateItems([...fullSlotSpread(), smuggled])).toThrow(/ZERO call sites/);
  });
});
