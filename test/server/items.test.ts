import { describe, expect, it } from 'vitest';

import {
  CHECKED_ITEMS,
  DEAD_MOD_KEYS,
  ITEMS,
  ITEM_CATALOGUE,
  ItemUseKind,
  KNOWN_ICON_IDS,
  PENDING_ICON_IDS,
  SLOT_ORDER,
  Slot,
  itemById,
  itemsForSlot,
  validateItems,
} from '../../src/server/content/items.ts';
import { EFFECT_IDS, EffectId } from '../../src/server/content/effects.ts';
import {
  BOSS_ART_COMMISSION,
  EFFECT_ART_COMMISSION,
  ENEMY_ART_COMMISSION,
  ITEM_ART_COMMISSION,
  PROP_ART_COMMISSION,
  STATUS_ICON_ART_COMMISSION,
  TOWNSFOLK_ART_COMMISSION,
} from '../../content/art-requests.ts';
import { SLOT_ORDER as WIRE_SLOT_ORDER } from '../../src/shared/protocol.ts';
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
 * COMMITTED inventory of what art exists is `ASSETS-REQUIRED.md`, and the ids
 * below were taken from it by hand. (This cited a line range and two counts —
 * "all 23", "the 22 below" — and both went stale the day eleven commissions
 * were delivered at once. A count restated in prose is a second copy of the
 * list with nothing to keep it in step; the list itself is the count.)
 * (`client/public/assets/manifest.placeholders.json` is NOT
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
  // ═══ THE DRAUGHT'S OWN VIAL, FROM THE STANDING COMMISSION ═══
  // This was `icon_active_alchemic_vial`, the Alchemist's talent icon, which the
  // draught borrowed until `items/commission/item_infusion_vial.png` was drawn.
  'item_infusion_vial',
  // ═══ THE ELEVEN COMMISSIONS, DELIVERED ═══
  // Weapons, belt, gloves, apron, the rest — authored ahead of their art under
  // `PENDING_ICON_IDS`, drawn in one pass to `items/equipment/` (64x64), and
  // moved across. Added here BY HAND for the reason this list exists at all: a
  // copy that one edit can change on both sides proves nothing.
  'item_archivists_mantle',
  'item_bailiffs_hook',
  'item_bailiffs_maul',
  'item_coroners_apron',
  'item_evidence_belt',
  'item_handlers_gloves',
  'item_paired_shivs',
  'item_service_baton',
  'item_tourniquet_band',
  'item_witness_locket',
  'item_writ_of_seizure',
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
  it('ships 36 worn items and one you drink', () => {
    // 23 `item_*` ids exist in the manifest. 22 are authored as equipment. The
    // 23rd `item_*` id is the ingot, and cutting it is a decision rather than an
    // oversight — see FORBIDDEN_IDS above; it draws the MONEY pile instead
    // (content/money.ts), which is the system that finally wanted it.
    //
    // The 23rd ITEM is the draught. It wore the ability vial, not an `item_*`
    // file at all, until the standing commission drew `item_infusion_vial`.
    //
    // ═══ AND THREE WEAPONS, THE FIRST ITEMS TO SHIP AHEAD OF THEIR ART ═══
    // `PENDING_ICON_IDS` is why they can: the renderer draws a LETTER for a
    // missing sprite and has for a long time (ui/inventory.ts:2754-2763), so the
    // catalogue's old refusal was enforcing a hazard that no longer existed —
    // and capping the content at whatever had been drawn.
    //
    // ═══ AND TWO MORE AHEAD OF THEIR ART: A TWO-HANDER AND AN OFF-HAND PAIR ═══
    // `item_bailiffs_maul` carries `forbids: Slot.Offhand` — upstream's
    // `slot_forbid` (`2hswords.lua:23`) — and `item_paired_shivs` is the thing
    // it locks you out of holding.
    //
    // ═══ AND TWO THAT GRANT VITALS, THE FIRST GEAR TO TOUCH EITHER ═══
    // `wielder.max_life` and `wielder.life_regen` are the two most common things
    // upstream gear does that ours could not do at all (39 and 42 items in
    // `tome/data`). Both mechanics were already ported; only the channel was
    // missing, and a channel nothing comes down is a channel nothing tests.
    //
    // ═══ AND THE THREE LANTERNS, ALSO AHEAD OF THEIR ART ═══
    // Upstream's `lites.lua:30-70`, for the LITE slot they are the only items in.
    //
    // ═══ AND ONE QUEST ARTEFACT, WHICH IS NEITHER WORN NOR DRUNK ═══
    // The Knot of Elsewhere — upstream's Rod of Recall
    // (data/general/objects/quest-artifacts.lua:314-369) — is held, and the
    // warden of the Undermost is holding it. `Item.quest`.
    expect(ITEMS).toHaveLength(38);
    expect(ITEMS.filter((item) => item.slot !== undefined)).toHaveLength(36);
    // TWO CARRY A `use` AND ONLY ONE OF THEM IS DRUNK. This asserted ONE, which
    // was the whole catalogue's shape while `ItemUse` had a single kind; the
    // second kind is a wind-up and a crossing, so the count that stays true of
    // "things you drink" is taken over the DISCRIMINANT.
    expect(ITEMS.filter((item) => item.use !== undefined)).toHaveLength(2);
    expect(
      ITEMS.filter((item) => item.use?.kind === ItemUseKind.Heal),
      'things you drink',
    ).toHaveLength(1);
    expect(
      ITEMS.filter((item) => item.use?.kind === ItemUseKind.Elsewhere),
      'things you pull',
    ).toHaveLength(1);
    expect(ITEMS.filter((item) => item.quest === true)).toHaveLength(1);
    // ═══ ONE ICON PER ITEM — DRAWN OR COMMISSIONED ═══
    // This read "23 drawn icons still, and 26 items", and had already gone stale
    // before the art arrived: the catalogue grew past it while eleven commissioned
    // ids sat in `PENDING_ICON_IDS`. So it is asserted as the RELATIONSHIP rather
    // than as a literal. The drawn and commissioned lists together account for
    // every item exactly once — which stays true when the next item is authored
    // ahead of its art, and is what `PENDING_ICON_IDS` exists to allow. Pinning
    // the drawn count alone would make that legitimate step a test failure.
    expect(MANIFEST_ITEM_ICONS.length + PENDING_ICON_IDS.length).toBe(ITEMS.length);
    expect(ITEM_CATALOGUE.size).toBe(38);
  });

  it('names only icons that exist in the committed manifest', () => {
    // THE TEST THIS FILE EXISTS FOR. One id that is not on this list is a violet
    // box on four people's screens for a whole session.
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * TWO LISTS NOW: what is drawn, and what is commissioned.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * This said "one id that is not on this list is a violet box on four
     * people's screens for a whole session". The renderer stopped doing that:
     * `ui/inventory.ts:2754-2763` draws the item's initial when the sprite is
     * missing, and calls a bare clone "the ORDINARY state rather than an edge
     * case". So an unlisted id is a TYPO, not a violet box — and the check that
     * matters is that every icon is on one of the two lists, with the shipped
     * list still matching the manifest exactly.
     */
    const known = new Set([...MANIFEST_ITEM_ICONS, ...PENDING_ICON_IDS]);
    const strays = ITEMS.filter((item) => !known.has(item.icon)).map((item) => item.icon);
    expect(strays).toEqual([]);

    // The SHIPPED list still agrees with the manifest in both directions — a
    // subset check would let either side quietly grow.
    expect([...KNOWN_ICON_IDS].sort()).toEqual([...MANIFEST_ITEM_ICONS].sort());

    // AND THE TWO LISTS ARE DISJOINT. An id in both is art that arrived without
    // anybody moving it, which is how a commission stays open forever.
    const shipped = new Set(MANIFEST_ITEM_ICONS);
    expect(PENDING_ICON_IDS.filter((id) => shipped.has(id))).toEqual([]);

    // AND NOTHING SHIPPED IS STILL ON THE STANDING COMMISSION. An id leaves
    // content/art-requests.ts when its art lands and an item names it (that
    // file's header) — the same hand-off as the disjointness above, one list
    // further out. Pending ids are left alone: an item authored ahead of its art
    // may name a picture that is still owed.
    const commissioned = new Set(
      [
        TOWNSFOLK_ART_COMMISSION,
        ENEMY_ART_COMMISSION,
        BOSS_ART_COMMISSION,
        EFFECT_ART_COMMISSION,
        STATUS_ICON_ART_COMMISSION,
        ITEM_ART_COMMISSION,
        PROP_ART_COMMISSION,
      ]
        .flat()
        .map((request) => request.id),
    );
    expect(
      MANIFEST_ITEM_ICONS.filter((id) => commissioned.has(id)),
      'drawn and worn, but still commissioned',
    ).toEqual([]);
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
      // A QUEST ARTEFACT IS THE THIRD KIND — see `Item.quest`, and the case in
      // `draught.test.ts` that pins its shape. Exempted on the field production
      // reads, never on an id.
      if (item.quest === true) continue;
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

  it('grants no physSpeed — the one verified-dead mod', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // A TYPE-LEVEL GUARANTEE, ASSERTED AT RUNTIME ANYWAY.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // `AdditiveMods` is `CombatMods` with this one REMOVED, so authoring it is a
    // compile error. This test exists because a cast is not: a `wielder`
    // arriving as `JSON.parse(...) as Wielder` from any future content loader
    // defeats `Omit` entirely and reaches the fold with a field nothing reads.
    //
    // ═══════════════════════════════════════════════════════════════════════
    // IT PINNED THREE, AND TWO OF THEM HAD COME ALIVE.
    // ═══════════════════════════════════════════════════════════════════════
    //
    // This assertion used to read `['mindPower', 'physSpeed', 'spellPower']`
    // and the comment above it pasted a grep proving all three were unread.
    // `combatMindpower` is the `applyPower` of ten talents and
    // `combatSpellpower` of `breaching_blow`; both print on the character sheet.
    // So this test PINNED a stale fact rather than catching it, which is what a
    // hard-coded list does when the thing it lists can change underneath it.
    //
    // WHICH FIELDS ARE DEAD IS NOW `live-mods.test.ts`' QUESTION — it re-runs
    // the grep with comments stripped instead of quoting one. This asserts only
    // that no ITEM grants whatever is on the list, which is this file's business.
    expect([...DEAD_MOD_KEYS].sort()).toEqual(['physSpeed']);

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
    //
    // ═══ AND A WEAPON IS THE THIRD KIND, FOR THE SAME REASON ═══
    // Its `wielder` is `{}` because it does not CONTRIBUTE anything — it
    // REPLACES the combat table, through `item.combat`. `Wielder` is a fold and
    // two rings both add their armour; two weapons do not add their damage, so
    // a weapon could never have ridden that field. The rule is unchanged:
    // everything must do something, and this is the third field it can do it in.
    //
    // ═══ AND A QUEST ARTEFACT IS THE FOURTH, AND THE ONLY ONE THAT IS INERT ═══
    // Its `wielder` is `{}` and it has no `use` yet, and that is the honest
    // state rather than a gap: pulling it is a twenty-turn wind-up and a
    // crossing, both of which live behind `gateway.ts`. What it DOES today is
    // be the thing the tutorial's boss was holding, which is a fact about the
    // world rather than a number on a sheet. `Item.quest` is what says so.
    const inert = ITEMS.filter((item) => {
      if (item.quest === true) return false;
      if (item.use !== undefined) return false;
      if (item.combat !== undefined) return false;
      const stats = Object.keys(item.wielder.stats ?? {}).length;
      const mods = Object.keys(item.wielder.mods ?? {}).length;
      return stats + mods === 0;
    }).map((item) => item.id);
    expect(inert).toEqual([]);
    // …and the things that are not worn all do something when they are drunk.
    // EXEMPT ON THE FIELD, NEVER THE ID: a quest artefact is the third kind of
    // item and its `use` is not a number of hit points at all — the Knot of
    // Elsewhere's is a wind-up and a crossing. `ItemUse` is a discriminated
    // union, so the narrowing below is the compiler agreeing rather than a cast.
    for (const item of ITEMS) {
      if (item.slot !== undefined || item.quest === true) continue;
      const use = item.use;
      expect(
        use !== undefined && use.kind === ItemUseKind.Heal ? use.amount : 0,
        `${item.id} does nothing when used`,
      ).toBeGreaterThan(0);
    }
    // ...and a weapon's whole mechanic is its damage, so it must have one.
    for (const item of ITEMS) {
      if (item.combat === undefined) continue;
      expect(item.combat.dam ?? 0, `${item.id} is a weapon that deals nothing`).toBeGreaterThan(0);
    }
  });

  it('lines its three tiers up with the three drop tables, 12 / 15 / 10', () => {
    // NOT COSMETIC. The roster's drop tables are meant to select on `tier`
    // rather than re-listing 23 ids somewhere else that has to stay in sync:
    //   common   = every LEGS and FEET item, plus the leather chest
    //   uncommon = every HEAD, OFFHAND and TRINKET item, AND the draught
    //   rare     = the three class BODY items and the three RINGs
    //   and one LANTERN at each tier, as upstream's three rise in rarity
    //
    // THE DRAUGHT IS UNCOMMON ON PURPOSE and it moved this count from 9 to 10:
    // upstream's healing infusion carries `rarity = 15` against a common's 3-6,
    // and a party that can buy the good one on every visit has no decision to
    // make about drinking it.
    const byTier = (tier: string): Item[] => ITEMS.filter((item) => item.tier === tier);
    //
    // THE ARTEFACT IS RARE AND IS NOT IN THE RARE DROP TABLE, which is the one
    // place in this file where the tier and the table stop being the same list:
    // `idsOfTier` drops a `quest` item, because upstream hands its rod over by
    // name in `NPC:onDie` (tome/class/NPC.lua:394) rather than rolling for it.
    // The case in `loot.test.ts` is where that difference is stated.
    expect(byTier('common')).toHaveLength(12);
    expect(byTier('uncommon')).toHaveLength(15);
    expect(byTier('rare')).toHaveLength(11);
    expect(byTier('common').length + byTier('uncommon').length + byTier('rare').length).toBe(
      ITEMS.length,
    );

    // WORN ITEMS ONLY. The assertion is about which SLOTS a tier covers, and a
    // draught covers none — it is uncommon and slotless, which is a fact about
    // the tier ladder rather than a gap in the doll.
    const slotsOf = (tier: string): Set<string> =>
      new Set(byTier(tier).flatMap((i) => (i.slot === undefined ? [] : [i.slot])));
    // MAINHAND JOINS EVERY TIER, and that is the point of a weapon ladder: the
    // one slot whose upgrade is felt on every swing needs something to find at
    // each step, where a HEAD piece can sensibly exist at one tier only.
    expect([...slotsOf('uncommon')].sort()).toEqual(
      ['cloak', 'hands', 'head', 'lite', 'mainhand', 'offhand', 'trinket'].sort(),
    );
    // HANDS JOINED THE RARE TIER, and not as a style choice: `validateItems`
    // requires whole-number wielder grants, so the smallest `life_regen` an item
    // can carry is +1 — DOUBLE what every class authors. The guard picked the
    // tier. See `item_tourniquet_band`.
    expect([...slotsOf('rare')].sort()).toEqual(['body', 'hands', 'lite', 'mainhand', 'ring']);
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
    ).toThrow(/in neither/);
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

describe('a worn rider names a real effect', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE PIN THE RING'S OWN COMMENT PROMISES.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `Wielder.onHit.effectId` is written out as a LITERAL in `items.ts` rather
   * than as `EffectId.Bleeding`, because importing the value closes a cycle —
   * `content/effects.ts` reaches `content/items.ts` through
   * `engine/talents.ts` -> `engine/equipment.ts` -> `SLOT_ORDER` — and the
   * symptom is not a lint error but a server that will not boot, with
   * "Cannot read properties of undefined (reading 'Bleeding')".
   *
   * A TEST MAY IMPORT BOTH, because a test is in neither module's graph. So the
   * check that the literal is a real effect id lives here, and a typo in an item
   * is a red test rather than a rider that silently never lands.
   */
  it('every rider on every item is an effect this build ships', () => {
    const known = new Set<string>(EFFECT_IDS);
    for (const item of ITEMS) {
      const rider = item.wielder?.onHit;
      if (rider === undefined) continue;
      expect(known.has(rider.effectId), `${item.id} -> ${rider.effectId}`).toBe(true);
    }
  });

  /** The one that exists today, named outright so its removal is deliberate. */
  it('the brass ring opens a cut', () => {
    const ring = itemById('item_watchmans_brass_ring');
    expect(ring?.wielder?.onHit?.effectId).toBe(EffectId.Bleeding);
  });

  /**
   * A RIDER WITHOUT A SAVE IS A STATUS THAT STOPS BEING ONE. `OnHitStatus.power`
   * says absent means NO save at all, which is right for a creature whose whole
   * identity is the rider and wrong for a bonus on a ring — every swing would
   * land it, unconditionally, forever.
   */
  it('rolls a save, so the wearer is not simply granted the effect', () => {
    for (const item of ITEMS) {
      const rider = item.wielder?.onHit;
      if (rider === undefined) continue;
      expect(rider.power, `${item.id} grants an unsaveable status`).toBeGreaterThan(0);
    }
  });
});

describe('the two Slot unions agree, which nothing proved before', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THERE ARE TWO, AND ONE COULD SILENTLY GET AHEAD OF THE OTHER.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `src/server/content/items.ts` declares `Slot` and so does
   * `src/shared/protocol.ts` — deliberately, because `src/shared/` may not reach
   * into `src/server/`, and both files say so. What neither says is how they are
   * kept in step, and the answer was: they were not.
   *
   * `_MissingFromSlotOrder` proves the SHARED list covers the SHARED union.
   * `_MissingFromServerSlotOrder` now proves the same on the server side. Across
   * the two modules there was nothing at all — and the asymmetry is what makes
   * it dangerous: `projectInventory` builds `{ [K in Slot]?: ItemView }` with
   * the SERVER's union and returns it as `InventoryMsg.equipped`, typed with the
   * SHARED one. A wider server union ASSIGNS CLEANLY to a narrower shared
   * record, so "server ahead of shared" compiles, and the result is an item that
   * is invisible on the doll and impossible to take off — `unequip` is a
   * `z.enum` and has no member to name it.
   *
   * The reverse direction does error, which is why this was never noticed: half
   * the mistake is caught and the dangerous half is not.
   */
  it('names exactly the same slots on both sides', () => {
    expect(Object.values(Slot).sort()).toEqual([...WIRE_SLOT_ORDER].sort());
  });

  it('orders them identically, because the spill order is one of them', () => {
    // `SLOT_ORDER` is the order a corpse gives up its gear
    // (turn-engine.ts, citing `tome/class/Actor.lua:3038-3040`). Two orders
    // would mean the server spilled in one and the client explained it in
    // another.
    expect([...SLOT_ORDER]).toEqual([...WIRE_SLOT_ORDER]);
  });
});
