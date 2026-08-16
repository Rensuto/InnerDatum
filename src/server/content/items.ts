// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported (SHAPE ONLY — every item below is authored for this game) from
//   t-engine4 game/engines/default/engine/Object.lua:104-107 (`wornInven` — `slot` names an inventory)
//   t-engine4 game/engines/default/engine/interface/ActorInventory.lua:563-572 (`onWear` — the `wielder` table IS the contribution)
//   t-engine4 game/modules/tome/data/general/objects/leather-boots.lua:21-22, :39-41
//              (a complete authored item: `slot = "FEET"` + `wielder = { combat_armor = 1 }`)
//   t-engine4 game/modules/tome/data/birth/descriptors.lua:56 (the `body` table — which slots exist and how many of each)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                     THE ITEM CATALOGUE. 22 ITEMS, 22 ICONS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME's object model is two fields and the rest is decoration:
 *
 * ```lua
 * -- Object.lua:104-107
 * function _M:wornInven()
 *   if not self.slot then return nil end
 *   return invens["INVEN_"..self.slot]        -- `slot` is a STRING naming an inventory
 * end
 *
 * -- ActorInventory.lua:563-572
 * function _M:onWear(o, inven_id)
 *   if o.wielder then
 *     for k, e in pairs(o.wielder) do o.wielded[k] = self:addTemporaryValue(k, e) end
 *   end
 * end
 *
 * -- leather-boots.lua:21-22, :39-41 — a WHOLE shipped item
 * slot = "FEET",
 * wielder = { combat_armor = 1 },
 * ```
 *
 * So an item is `slot` + `wielder` + decoration, and that is exactly what `Item`
 * below is. ToME's `combat_armor` / `combat_def` / `combat_atk` / `combat_dam`
 * map one-for-one onto our `mods.armour` / `def` / `atk` / `dam`
 * (engine/derived.ts:111-146), which is why the shape ports without a
 * translation table.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DESIGN IS FITTED TO THE ART, NOT THE OTHER WAY ROUND
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `client/public/assets/` is gitignored wholesale and an unresolved sprite id
 * renders as a LOUD violet fallback box, so a catalogue is only as big as the
 * icon set. There are 23 `item_*` ids in `manifest.placeholders.json`. Twenty-two
 * are authored here. The twenty-third, `item_iron_ingot`, IS DELIBERATELY NOT
 * AUTHORED — see the note on `KNOWN_ICON_IDS`.
 *
 * FOUR IDS THAT LOOK AVAILABLE AND ARE NOT. `assets/items/_aliases.json` claims
 * `item_watchmans_truncheon`, `item_inspectors_revolver`,
 * `item_inquisitors_reckoner` and `item_iron_sword` resolve onto
 * `icon_weapon_*` art. THAT FILE IS WRONG: neither those four ids nor any
 * `icon_weapon_*` id exists on disk or in the manifest. Referencing one would
 * ship a violet box. Hence: THERE IS NO WEAPON SLOT AND NO MAINHAND. A class's
 * weapon stays part of its authored `CombatSheet` (content/classes.ts), exactly
 * as it was before this file existed.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO DELIBERATE DEVIATIONS FROM ToME'S `body` TABLE (descriptors.lua:56)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream's player body is
 * `{ INVEN=1000, MAINHAND=1, OFFHAND=1, FINGER=2, NECK=1, LITE=1, BODY=1,
 *    HEAD=1, CLOAK=1, HANDS=1, BELT=1, FEET=1, TOOL=1, QUIVER=1, ... }`.
 *
 *   1. FINGER=2 BECOMES RING=1. Upstream's second ring slot exists to absorb the
 *      enormous space of randomly-generated ego rings. We have exactly three
 *      rings and all three are authored by hand, so a second finger would mean
 *      "wear two of the three you own" rather than "choose".
 *
 *   2. ONE SHARED BODY TABLE, NOT ONE PER CLASS. Upstream genuinely supports
 *      per-creature tables (descriptors.lua:56 against npcs/ant.lua:29 and
 *      npcs/lich.lua:31). Ours is shared, because loot on this game's floor is
 *      an UNOWNED pile that three to six players are standing around: a drop
 *      only one class can wear is a drop that is dead on arrival most of the
 *      time it appears.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BALANCE RULE THAT DECIDED EVERY NUMBER BELOW: ARMOUR UNDER APR IS ZERO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `damage.ts` applies `effective = max(0, armour - apr)` (Combat.lua:540), and
 * this roster's armour penetration is husk 7, elite 8, wraith 15
 * (content/monsters.ts). content/monsters.ts:405-406 already records the
 * consequence in its own balance table: the husk deals the IDENTICAL 4.378 hp
 * per player turn to the armour-6 Watchman and the armour-0 Inspector, because
 * `max(0, 6 - 7) = 0`.
 *
 * So:
 *   - THE WATCHMAN'S KIT IS SIZED TO CLEAR apr 7-8 OR IT IS COSMETIC. The cap
 *     alone (+3) takes him from armour 6 to 9, which clears the husk's 7 by two
 *     and the elite's 8 by one — the FIRST piece he finds already moves a number
 *     a player can read off the character sheet. Everything after it compounds.
 *   - NO ARMOUR IS GRANTED TO THE INSPECTOR OR THE ALCHEMIST KITS. A +2 armour
 *     longcoat measures as literally no change against every creature in the
 *     game. Their survivability lever is `mods.def`, which is worth a flat 2.5
 *     percentage points of the attacker's hit chance per point
 *     (`ceil(50 + 2.5*(atk-def))`, src/shared/checkhit.ts) and works regardless
 *     of anybody's apr.
 *
 * SECOND RULE, AND IT IS WHY NO STAT GRANT IS SMALLER THAN +3:
 * `rescaleCombatStats` FLOORS (src/shared/scale.ts:116). A +1 or +2 primary can
 * rescale to the same integer it started on and move nothing at all. Every
 * `stats` grant here is +3 or +4, and test/server/equipment.test.ts proves each
 * of the 22 individually moves at least one derived getter.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TIER IS ALSO THE DROP TABLE, AND THAT IS NOT A COINCIDENCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   common   (7) — every LEGS and FEET item, plus the leather chest
 *   uncommon (9) — every HEAD, OFFHAND and TRINKET item
 *   rare     (6) — the three class BODY items and the three RINGs
 *
 * The three rosters' drop tables are meant to be those three sets verbatim, so
 * the pass that adds drops can select on `tier` rather than re-listing 22 ids in
 * a second place that has to be kept in sync.
 *
 * PURE AND SYNCHRONOUS. This file imports TYPES ONLY, which is what keeps it at
 * the bottom of the module graph: `engine/equipment.ts` and `world/world.ts`
 * both value-import from here, and a runtime edge back into the engine would
 * close a cycle in a project with no build step — which is a ReferenceError at
 * import time, not a warning.
 */

import type { CombatMods, PrimaryStats } from '../engine/derived.ts';

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/**
 * The seven worn slots, max one item each.
 *
 * Object + union rather than an `enum`, because `erasableSyntaxOnly` is on and
 * Node type-strips this file to run it (CLAUDE.md § 1).
 *
 * The values are ToME's slot names lowercased (`body`, `head`, `feet` are
 * upstream's verbatim — descriptors.lua:56), so `grep -rn '"body"'
 * reference/t-engine4` still finds the thing this was ported from.
 */
export const Slot = {
  Head: 'head',
  Body: 'body',
  Legs: 'legs',
  Feet: 'feet',
  Offhand: 'offhand',
  Ring: 'ring',
  Trinket: 'trinket',
} as const;
export type Slot = (typeof Slot)[keyof typeof Slot];

/**
 * DECLARATION ORDER, FROZEN, AND IT IS LOAD-BEARING.
 *
 * `engine/equipment.ts#wornOf` folds gear in exactly this order so the input to
 * the fold is never a Map's iteration order — which is whatever order a player
 * happened to press buttons in, and therefore differs between two replays of one
 * seed. Addition commutes, so the composed sheet would come out the same either
 * way; anything DERIVED from the iteration (a log line, a draw, a dropped-item
 * order on death) would not. Fixing it once here is cheaper than proving every
 * future consumer commutes.
 *
 * Same argument, same shape, as `STAT_KEYS` in engine/derived.ts:540.
 */
export const SLOT_ORDER: readonly Slot[] = Object.freeze([
  Slot.Head,
  Slot.Body,
  Slot.Legs,
  Slot.Feet,
  Slot.Offhand,
  Slot.Ring,
  Slot.Trinket,
]);

// ---------------------------------------------------------------------------
// What an item is allowed to contribute
// ---------------------------------------------------------------------------

/**
 * The primaries an item may grant. `lck` IS EXCLUDED AT THE TYPE LEVEL.
 *
 * Luck is pinned at its default 50 so that the nine ToME formulas carrying a
 * `(Lck − 50)` term all vanish to zero and the ported arithmetic stays
 * byte-comparable against the Lua (engine/derived.ts:44-52). An item that moved
 * Luck would unpin nine formulas at once, silently, from the content layer. If
 * Luck is ever wanted it is a deliberate change to derived.ts and this line, not
 * a ring somebody authored on a Tuesday.
 */
export type AdditiveStats = Omit<PrimaryStats, 'lck'>;

/**
 * The `combat_*` mods an item may grant — every one EXCEPT the three that are
 * verified dead in this codebase.
 *
 * ═══ WHY THE OMIT IS THE STRUCTURAL DEFENCE AGAINST "AN ITEM THAT DOES NOTHING"
 * `grep -rn 'combatSpeed\|combatSpellpower\|combatMindpower' src/` returns
 * COMMENTS ONLY — zero call sites. Nothing in this game reads attack speed,
 * spell power or mind power, so an item granting one would be inert: it would
 * type-check, persist, appear in the inventory, print a tooltip, and change no
 * number anywhere. content/classes.ts:295 already carries a dead
 * `mods: { spellPower: 4 }` on the Alchemist, which is the proof this is a
 * mistake somebody makes rather than a hypothetical.
 *
 * Removing them from the TYPE makes that a compile error instead of a design
 * review. The day a `combatSpeed` call site lands, deleting a name from this
 * `Omit` is the whole change.
 *
 * NOTE: `mods.armourHardiness` is ADDITIVE onto a base of 30 (Combat.lua:1336),
 * not a percentage of anything, so it belongs in an additive fold like the rest.
 */
export type AdditiveMods = Omit<CombatMods, 'physSpeed' | 'spellPower' | 'mindPower'>;

/**
 * ToME's `wielder` table — ActorInventory.lua:563-572.
 *
 * ADDITIVE ONLY, AND THAT IS THE WHOLE CONTRACT. Upstream supports `mult`,
 * `perc_inv`, `inv1` and `highest` merge methods (Entity.lua:985-996), and its
 * own removal path un-applies them by DIVISION and by
 * `1 - (1 - b) / (1 - v)` — float round trips that drift, which is why
 * tome/class/Actor.lua:105-108 retrofits four speed properties back to plain
 * `add`, the second of them commented *"Prevent excessive attack speed
 * compounding"* (:104 is `global_speed_add = "newest"` and is not one of them). We
 * import that lesson at the type level instead of learning it twice: there is no
 * field here that is not a plain number added to a plain number.
 */
export type Wielder = {
  readonly stats?: Partial<AdditiveStats>;
  readonly mods?: Partial<AdditiveMods>;
};

/** Rarity, and — by construction — the drop tier. See the file header. */
export type ItemTier = 'common' | 'uncommon' | 'rare';

/**
 * One authored item.
 *
 * `id` and `icon` are the same string for all 22, and that is a fact rather than
 * a rule: the art was drawn for these items and named after them. They are kept
 * as two fields because they answer two different questions — `id` is what the
 * save file and the wire carry, `icon` is a key into a manifest the server never
 * reads — and collapsing them would make renaming a sprite a save-migration.
 */
export type Item = {
  readonly id: string;
  readonly name: string;
  readonly slot: Slot;
  /** A manifest asset key, never a path. Must be one of `KNOWN_ICON_IDS`. */
  readonly icon: string;
  readonly tier: ItemTier;
  readonly wielder: Wielder;
  /** One sentence, shown in the inventory. Flavour; it decides nothing. */
  readonly desc: string;
};

// ---------------------------------------------------------------------------
// The verified icon set
// ---------------------------------------------------------------------------

/**
 * THE 22 IDS THAT EXIST AS FILES AND AS MANIFEST ENTRIES, WRITTEN OUT.
 *
 * Hardcoded rather than globbed, because the art directory is gitignored: a
 * clone of this repository has no `client/public/assets/` at all, and a check
 * that reads the disk would pass vacuously on exactly the machine that most
 * needs it (CI). test/server/items.test.ts pins the same list a second time so
 * that editing one copy without the other fails.
 *
 * ═══ THE COMMITTED CROSS-CHECK IS `ASSETS-REQUIRED.md:84-109`, NOT THE MANIFEST
 * ═══
 * An earlier draft of this paragraph said the list "was taken from
 * `manifest.placeholders.json`, which is committed". IT IS NOT COMMITTED:
 * `.gitignore:56` ignores `client/public/assets/` whole, the manifest included,
 * so a contributor following that instruction on a fresh clone finds no such
 * file. `ASSETS-REQUIRED.md` IS tracked and its `items/` section lists all 23
 * ids with their sizes — that is the document to check a new id against, and to
 * add one to when the artist cuts a new file.
 *
 * ═══ `item_iron_ingot` IS ON DISK AND IS DELIBERATELY MISSING FROM THIS LIST ═══
 * It is the 23rd icon and it is not authored as an item. ToME would ship it as
 * junk — `{ type = "money" }`, npcs/ant.lua:220 — but we have no currency, no
 * vendor and no crafting, so its only property would be occupying an inventory
 * cell. An item that changes no number is worse than no item: it teaches the
 * player that picking things up is not worth the turn it costs. It stays an
 * unused PNG until there is a system that wants it.
 */
export const KNOWN_ICON_IDS: readonly string[] = Object.freeze([
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
]);

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/**
 * THE WATCHMAN KIT — armour, and the only kit whose armour is worth anything.
 *
 * Measured against the roster (see the file header for the formulas):
 *   cap + coat + trousers + buckler take armour 6 → 16 and hardiness 40% → 50%.
 *   vs HUSK  (atk 19, apr 7, dam 5.527, ×0.9 cadence): 4.378 → 1.865 hp/turn, −57.4%
 *   vs ELITE (atk 21, apr 8, dam 7.096):               6.600 → 2.839 hp/turn, −57.0%
 *   vs the WRAITH'S ORB (apr 15): NO MEANINGFUL CHANGE. 16 − 15 = 1 point of
 *   effective armour, and defence does not apply to a projectile at all. That
 *   hole is designed and it is written down here so the next person does not
 *   "fix" it by inflating armour until it closes.
 */
const WATCHMAN_KIT: readonly Item[] = [
  {
    id: 'item_watchmans_cap',
    name: "Watchman's Cap",
    slot: Slot.Head,
    icon: 'item_watchmans_cap',
    tier: 'uncommon',
    // +3 IS THE THRESHOLD PIECE. Armour 6 → 9 clears the husk's apr 7 and the
    // elite's 8; at +2 the whole item measures as zero against both.
    wielder: { mods: { armour: 3 } },
    desc: 'Reinforced felt with a brass band. It has been dented and beaten flat again.',
  },
  {
    id: 'item_watchmans_coat',
    name: "Watchman's Coat",
    slot: Slot.Body,
    icon: 'item_watchmans_coat',
    tier: 'rare',
    // The hardiness is the half that makes the armour matter: it widens the
    // slice of each blow armour is allowed to bite into, 40% → 50%
    // (Combat.lua:1336, base 30 + the Watchman's authored 10 + this).
    wielder: { mods: { armour: 4, armourHardiness: 10 } },
    desc: 'Heavy wool over a mail lining. Rain runs off it; so does most of a blow.',
  },
  {
    id: 'item_watchmans_trousers',
    name: "Watchman's Trousers",
    slot: Slot.Legs,
    icon: 'item_watchmans_trousers',
    tier: 'common',
    wielder: { mods: { armour: 2 } },
    desc: 'Serge, double-seated, with a strip of boiled leather down each shin.',
  },
  {
    id: 'item_watchmans_boots',
    name: "Watchman's Boots",
    slot: Slot.Feet,
    icon: 'item_watchmans_boots',
    tier: 'common',
    // DEFENCE, not armour, on the smallest piece: +2 def is 5 percentage points
    // of the attacker's hit chance and works against every creature in the game;
    // +2 armour would be exactly zero against all three of them.
    wielder: { mods: { def: 2 } },
    desc: 'Hobnailed and half a size too big. Twenty years of beat walking is in the sole.',
  },
  {
    id: 'item_watchmans_buckler',
    name: "Watchman's Buckler",
    slot: Slot.Offhand,
    icon: 'item_watchmans_buckler',
    tier: 'uncommon',
    wielder: { mods: { def: 3, armour: 1 } },
    desc: 'A small round shield, strapped to the forearm. Meant for a doorway.',
  },
  {
    id: 'item_watchmans_badge',
    name: "Watchman's Badge",
    slot: Slot.Trinket,
    icon: 'item_watchmans_badge',
    tier: 'uncommon',
    wielder: { mods: { atk: 3 } },
    desc: 'Numbered, tarnished, and still legible. People stop moving when they see it.',
  },
  {
    id: 'item_watchmans_brass_ring',
    name: 'Brass Constable Ring',
    slot: Slot.Ring,
    icon: 'item_watchmans_brass_ring',
    tier: 'rare',
    // +3, never +1 or +2: `rescaleCombatStats` floors (scale.ts:116) and a
    // smaller grant can round away to nothing at all.
    wielder: { stats: { str: 3 } },
    desc: 'Issued on the day of the oath. The band has worn thin from the inside.',
  },
];

/**
 * THE INSPECTOR KIT — accuracy, evasion and crit. Zero armour, deliberately.
 *
 *   longcoat + slacks give def 4 → 11 against a husk's atk 19: 88% → 70% to hit,
 *   which is 4.378 → 3.482 hp/turn, −20.5%. `mods.dam +4` and `dex +3` move
 *   `combatDamage` 11.54 → 13.10 (+13.5%) and accuracy 21 → 24, which against
 *   the wraith's defence 19 is 55% → 63% to hit.
 */
const INSPECTOR_KIT: readonly Item[] = [
  {
    id: 'item_inspectors_deerstalker',
    name: "Inspector's Deerstalker",
    slot: Slot.Head,
    icon: 'item_inspectors_deerstalker',
    tier: 'uncommon',
    wielder: { mods: { atk: 3 } },
    desc: 'Checked tweed with both flaps down. Nobody has ever taken it seriously and it has never mattered.',
  },
  {
    id: 'item_inspectors_longcoat',
    name: "Inspector's Longcoat",
    slot: Slot.Body,
    icon: 'item_inspectors_longcoat',
    tier: 'rare',
    // NO ARMOUR ON THIS ITEM, ON PURPOSE. See the file header: any armour total
    // below the attacker's apr is worth exactly zero, and the Inspector starts
    // at 0 against a roster whose lowest apr is 7. A "+2 armour" longcoat would
    // read as an upgrade on the sheet and be inert in the fight.
    wielder: { mods: { def: 4 } },
    desc: 'Oilcloth to the ankle. It moves a half-second after you do, which is the point.',
  },
  {
    id: 'item_inspectors_slacks',
    name: "Inspector's Slacks",
    slot: Slot.Legs,
    icon: 'item_inspectors_slacks',
    tier: 'common',
    wielder: { mods: { def: 2 } },
    desc: 'Pressed, unfashionable, and cut wide enough to run in.',
  },
  {
    id: 'item_inspectors_oxfords',
    name: "Inspector's Oxfords",
    slot: Slot.Feet,
    icon: 'item_inspectors_oxfords',
    tier: 'common',
    // Dex is the Inspector's double-dip: +1 accuracy AND +0.35 defence per
    // point (Combat.lua:1355 and :1245), so a stat grant here beats a flat one.
    wielder: { stats: { dex: 3 } },
    desc: 'Thin soles, perfect polish. You can hear a floorboard through them.',
  },
  {
    id: 'item_inspectors_dossier',
    name: "Inspector's Dossier",
    slot: Slot.Offhand,
    icon: 'item_inspectors_dossier',
    tier: 'uncommon',
    // OFFHAND rather than a trinket: it is a case file HELD IN THE OTHER HAND.
    // The three kits are not symmetric — the Watchman has a shield and no neck
    // item, the Inspector has a locket and no shield — and forcing them to match
    // would mean inventing art that does not exist.
    wielder: { mods: { dam: 4 } },
    desc: 'Every page a name, every name crossed out but one. You keep finding new margins.',
  },
  {
    id: 'item_inspectors_signet',
    name: "Inspector's Signet",
    slot: Slot.Ring,
    icon: 'item_inspectors_signet',
    tier: 'rare',
    // `combatCrit` is NOT rescaled (Combat.lua:1415-1427 returns max(crit, 0)),
    // so +4 here is four whole percentage points and reads exactly as written.
    wielder: { mods: { physCrit: 4 } },
    desc: 'A seal for warrants. The die is worn to the point where only you can read it.',
  },
  {
    id: 'item_inspectors_locket',
    name: "Inspector's Locket",
    slot: Slot.Trinket,
    icon: 'item_inspectors_locket',
    tier: 'uncommon',
    wielder: { mods: { mentalResist: 8 } },
    desc: 'It does not open any more. Whatever is inside is the reason you are still down here.',
  },
];

/**
 * THE ALCHEMIST KIT — the `inquisitors_*` art, and the naming needs saying out
 * loud: THERE IS NO INQUISITOR PLAYER CLASS. `enemy_high_inquisitor_s` is a
 * MONSTER sprite; the three classes are the Watchman, the Inspector and the
 * Alchemist of Ashwick Row (content/classes.ts). This kit is cowled, sealed and
 * full of ciphers, which is the Alchemist, so it is hers. The ids stay as the
 * art names them because renaming a sprite id to match a class would break the
 * one link between this file and a PNG nobody can see from here.
 *
 *   cowl + seal move mag 22 → 29 and the tome adds `mods.dam +5`, taking
 *   `combatDamage` 9.66 → 12.29, +27.2% — the largest offensive swing of the
 *   three, because the Alchemist starts with no gear-shaped stats at all.
 *   mantle + breeches + treads take def 0 → 9, which against a husk's atk 19 is
 *   98% → 75% to hit: 4.875 → 3.731 hp/turn, −23.5%.
 */
const ALCHEMIST_KIT: readonly Item[] = [
  {
    id: 'item_inquisitors_cowl',
    name: "Inquisitor's Cowl",
    slot: Slot.Head,
    icon: 'item_inquisitors_cowl',
    tier: 'uncommon',
    wielder: { stats: { mag: 4 } },
    desc: 'Waxed canvas, chemical-burned at the hem. It keeps the fumes out of your eyes.',
  },
  {
    id: 'item_inquisitors_mantle',
    name: "Inquisitor's Mantle",
    slot: Slot.Body,
    icon: 'item_inquisitors_mantle',
    tier: 'rare',
    // Again NO ARMOUR: the Alchemist's armour is 0 and the roster's floor apr is
    // 7, so anything short of +7 on one item is arithmetic that never fires.
    wielder: { mods: { def: 3, spellResist: 8 } },
    desc: 'Layered oilskin, stitched with lead thread. The Veil slides off it.',
  },
  {
    id: 'item_inquisitors_breeches',
    name: "Inquisitor's Breeches",
    slot: Slot.Legs,
    icon: 'item_inquisitors_breeches',
    tier: 'common',
    wielder: { mods: { def: 3 } },
    desc: 'Cut short and bound at the knee, so nothing catches when a vial goes off.',
  },
  {
    id: 'item_inquisitors_treads',
    name: "Inquisitor's Treads",
    slot: Slot.Feet,
    icon: 'item_inquisitors_treads',
    tier: 'common',
    wielder: { mods: { def: 3 } },
    desc: 'Cork soles over iron shanks. Silent on stone, and they do not conduct.',
  },
  {
    id: 'item_inquisitors_tome',
    name: "Inquisitor's Tome",
    slot: Slot.Offhand,
    icon: 'item_inquisitors_tome',
    tier: 'uncommon',
    // OFFHAND for the same reason as the dossier: it is held, not worn.
    wielder: { mods: { dam: 5 } },
    desc: 'Formulae in four hands, none of them yours. The last twenty pages are blank.',
  },
  {
    id: 'item_inquisitors_seal',
    name: "Inquisitor's Seal",
    slot: Slot.Ring,
    icon: 'item_inquisitors_seal',
    tier: 'rare',
    wielder: { stats: { mag: 3 } },
    desc: 'Bone set in silver. Warm before a reaction, cold for an hour afterwards.',
  },
  {
    id: 'item_inquisitors_cipher',
    name: "Inquisitor's Cipher",
    slot: Slot.Trinket,
    icon: 'item_inquisitors_cipher',
    tier: 'uncommon',
    // Cunning feeds `combatCrit` at 0.3/point OUTSIDE the rescale, so +4 is a
    // clean +1.2 crit chance that no floor can eat.
    wielder: { stats: { cun: 4 } },
    desc: 'A brass wheel of substitutions. Turning it makes the Index legible for a moment.',
  },
];

/**
 * THE CLASS-NEUTRAL ITEM, AND IT IS DELIBERATELY THE WORST ONE.
 *
 * ToME's whole low-level object table is exactly this: `BASE_LEATHER_*` with a
 * one-line `wielder` (leather-boots.lua:39-41 is `combat_armor = 1`). Ours is
 * the piece anybody can wear on the floor of the first room, which is what makes
 * the Watchman's coat feel like something when it finally drops.
 *
 * Its +3 armour is the one armour grant a non-Watchman will ever see, and on an
 * Inspector or Alchemist it is worth ZERO against this roster — the `def: 1` is
 * the part that actually fires for them. That asymmetry is honest: a shared item
 * is better for the class it was not designed around than nothing, and the
 * character sheet shows exactly why.
 */
const GENERIC_ITEMS: readonly Item[] = [
  {
    id: 'item_leather_chest',
    name: 'Leather Chestpiece',
    slot: Slot.Body,
    icon: 'item_leather_chest',
    tier: 'common',
    wielder: { mods: { armour: 3, def: 1 } },
    desc: 'Boiled, riveted, and salvaged off somebody who stopped needing it.',
  },
];

/** Every authored item, in a fixed order. Kit order, then the generic tail. */
export const ITEMS: readonly Item[] = Object.freeze([
  ...WATCHMAN_KIT,
  ...INSPECTOR_KIT,
  ...ALCHEMIST_KIT,
  ...GENERIC_ITEMS,
]);

/** What `wornOf` and every persistence path look ids up in. */
export type ItemCatalogue = ReadonlyMap<string, Item>;

/** id → item. Insertion order is `ITEMS` order, which is stable across runs. */
export const ITEM_CATALOGUE: ItemCatalogue = new Map(ITEMS.map((item) => [item.id, item]));

/** One item, or undefined for an id this build does not know. */
export function itemById(id: string): Item | undefined {
  return ITEM_CATALOGUE.get(id);
}

/** Every item that can go in one slot, in catalogue order. */
export function itemsForSlot(slot: Slot): readonly Item[] {
  return ITEMS.filter((item) => item.slot === slot);
}

// ---------------------------------------------------------------------------
// The import-time arity check
// ---------------------------------------------------------------------------

/**
 * The three `CombatMods` fields `AdditiveMods` removes, restated as STRINGS.
 *
 * The type is the real defence; this is the belt to that braces. A `wielder`
 * arriving through a cast — `JSON.parse(...) as Wielder`, which is exactly how a
 * content loader would smuggle one in — defeats `Omit` entirely and reaches the
 * fold with a field nothing in the game reads. Exported because
 * test/server/items.test.ts asserts the same list at runtime against the shipped
 * catalogue, and two copies that must agree are better named once.
 */
export const DEAD_MOD_KEYS: readonly string[] = Object.freeze([
  'physSpeed',
  'spellPower',
  'mindPower',
]);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IT THROWS AT MODULE LOAD, AND THAT TAKES THE SERVER DOWN BEFORE THE FIRST
 * CONNECTION. THAT IS THE INTENDED TRADE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Modelled on `_loadoutArityCheck` in content/classes.ts:787-796, which does the
 * same thing for the four-talents-per-class rule and for the same reason: a
 * content mistake that survives startup is a content mistake four friends
 * discover in a voice channel on a Friday night. A server that refuses to boot
 * is one line in a terminal the host is already looking at.
 *
 * The five things it proves, and what each one prevents:
 *
 *   1. NO DUPLICATE IDS — a duplicate silently shadows in `ITEM_CATALOGUE` and
 *      the loser becomes an item that can drop and can never be equipped.
 *   2. EVERY ICON IS A KNOWN ID — an unknown one renders as the LOUD violet
 *      fallback box on every client. It is the failure this project's asset
 *      rules exist to make impossible, and `item_iron_ingot` and the four
 *      aliased weapon ids are all caught here.
 *   3. NO TWO ITEMS SHARE AN ICON — two things that look identical in a list you
 *      pick from is a UI bug with no error attached to it.
 *   4. EVERY SLOT HAS AT LEAST ONE ITEM — an empty slot is a row on the
 *      equipment screen that can never be filled, i.e. a promise the content
 *      does not keep.
 *   5. EVERY WIELDER VALUE IS A FINITE, NON-NEGATIVE INTEGER. Non-negative
 *      because a "cursed" item is a design this game has not made; finite
 *      because a NaN propagates through `combatDamage` into a damage roll and
 *      the first visible symptom is a monster that cannot be killed. And
 *      INTEGER, which is the least obvious and the most important: the fold in
 *      engine/equipment.ts is plain floating-point addition, and float addition
 *      is not associative — `0.1 + 0.2 + 0.3` differs from `0.3 + 0.2 + 0.1` in
 *      the last bit. Integers make the fold EXACTLY order-independent, which is
 *      what test/server/equipment.test.ts proves across all 5040 permutations of
 *      a seven-piece kit. Allow a fractional wielder value and that proof
 *      quietly becomes a proof about one ordering.
 */
export function validateItems(items: readonly Item[]): readonly Item[] {
  const seenIds = new Set<string>();
  const seenIcons = new Set<string>();
  const knownIcons = new Set(KNOWN_ICON_IDS);
  const populated = new Set<Slot>();

  for (const item of items) {
    if (seenIds.has(item.id)) throw new Error(`items: duplicate id '${item.id}'`);
    seenIds.add(item.id);

    if (!knownIcons.has(item.icon)) {
      throw new Error(
        `items: ${item.id} names icon '${item.icon}', which is not one of the ` +
          `${KNOWN_ICON_IDS.length} ids in the committed asset manifest — it would render ` +
          `as the violet fallback box on every client`,
      );
    }
    if (seenIcons.has(item.icon)) throw new Error(`items: duplicate icon '${item.icon}'`);
    seenIcons.add(item.icon);

    populated.add(item.slot);

    const contributions: readonly (readonly [string, number | undefined])[] = [
      ...Object.entries(item.wielder.stats ?? {}),
      ...Object.entries(item.wielder.mods ?? {}),
    ];
    for (const [key, value] of contributions) {
      if (DEAD_MOD_KEYS.includes(key)) {
        throw new Error(
          `items: ${item.id} grants '${key}', which has ZERO call sites in src/ — ` +
            `it would be an item that changes no number a player can see`,
        );
      }
      if (value === undefined) continue;
      if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
        throw new Error(
          `items: ${item.id} grants ${key} = ${String(value)}; wielder values must be ` +
            `finite non-negative INTEGERS (see the note on this check for why)`,
        );
      }
    }
  }

  for (const slot of SLOT_ORDER) {
    if (!populated.has(slot)) throw new Error(`items: no item exists for slot '${slot}'`);
  }

  return items;
}

/**
 * THE CHECK, RUN. Exported so it is not dead code to the compiler, and so a test
 * can assert it ran at all. It is `ITEMS`, by identity.
 *
 * `validateItems` is a FUNCTION rather than an inlined IIFE for exactly one
 * reason: a test has to be able to prove the check rejects a malformed item, and
 * it cannot do that against a check that only ever sees the real catalogue.
 */
export const CHECKED_ITEMS: readonly Item[] = validateItems(ITEMS);
