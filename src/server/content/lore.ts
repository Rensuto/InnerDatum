// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported (SHAPE ONLY — every note below is authored for this game) from
//   t-engine4 game/modules/tome/class/interface/PartyLore.lua:38-52 (`newLore` — id, category, name, lore)
//   t-engine4 game/modules/tome/class/interface/PartyLore.lua:102-131 (`learnLore` — found once, known forever)
//   t-engine4 game/modules/tome/class/Object.lua:2308-2318 (`on_prepickup` — a lore object is READ, never carried)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CASE NOTES. Paper you find on a floor, read once, and keep forever.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is ToME's LORE, which is a system rather than a decoration:
 * `PartyLore.lua` defines them, `learnLore` files them, `LorePopup` shows the
 * one you just found and `ShowLore` is where you re-read the lot. Upstream
 * scatters them through every zone and they are how a player learns what the
 * world IS without anybody stopping to explain it.
 *
 * ═══ IT IS THE PARTY THAT KNOWS, NOT THE READER ═══
 * `learnLore` is a method on the PARTY (`PartyLore` is mixed into it, not into
 * Actor), so one member picking a note up teaches everybody. That is upstream's
 * shape and it is the right one here for a reason upstream never had: four
 * people are in a voice channel and one of them is holding the paper. A system
 * where the others had to queue up to read it would be a system that produces
 * silence.
 *
 * ═══ A NOTE IS NOT LOOT AND IS NEVER CARRIED ═══
 * `Object.lua:2313-2315` removes the object from the map and calls `learnLore`
 * — it never reaches an inventory. So a note costs no bag slot, cannot be
 * dropped, sold or handed over, and picking one up twice is impossible because
 * the second one does not exist. `INVENTORY_CAP` is 12 and a player who filled
 * it with paper would have found a way to lose the game by reading.
 *
 * ═══ THE TEXT IS AUTHORED, THE SHAPE IS PORTED ═══
 * Every word below is this game's. What is ported is the RECORD — an id, a
 * category, a name and a body — and the rules around it. `newLore` asserts all
 * four; so does `LORE`, through the type.
 */

/**
 * WHICH SHELF A NOTE BELONGS ON. `newLore` asserts a category and `ShowLore`
 * groups by it — a flat list of forty notes is an archive nobody opens.
 *
 * A const object rather than an `enum`: `erasableSyntaxOnly` is on and an enum
 * emits runtime code the type-stripping loader refuses.
 */
export const LoreCategory = {
  /** What the Index is, in the words of people who worked for it. */
  Index: 'the index',
  /** The town, the canal, the people who live there. */
  Alderbrook: 'alderbrook',
  /** Procedure, and the men who wrote it down. */
  Watch: 'the watch',
} as const;
export type LoreCategory = (typeof LoreCategory)[keyof typeof LoreCategory];

export type Lore = {
  /** Stable, and the key everything else joins on. Never shown to a player. */
  readonly id: string;
  readonly category: LoreCategory;
  /** The heading, and what the Case Log names when it is found. */
  readonly name: string;
  /**
   * The body. Plain text — no markup, because `LorePopup`'s `[i]`/`[b]` tags are
   * a Lua string substitution into that engine's own font codes and we have
   * neither. A note that needed emphasis to land is a note that needs rewriting.
   */
  readonly text: string;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE NOTES THEMSELVES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * FROZEN, and ordered — `newLore` stamps `t.order = #self.lore_defs+1` and
 * `ShowLore` lists in that order, so the array's order is the reading order and
 * is not to be sorted anywhere downstream.
 *
 * Short on purpose. Upstream's longest lore runs to several screens and its own
 * dialog scrolls; ours is a card on a game screen inside a Discord window, and a
 * note nobody finishes is a note nobody reads.
 */
export const LORE: readonly Lore[] = Object.freeze([
  {
    id: 'lore_intake_form',
    category: LoreCategory.Index,
    name: 'Intake Form, Unfinished',
    text:
      'Name, occupation, last known address. Then a fourth box, wider than the others, ' +
      'with no label over it. The hand that filled the first three stops there. ' +
      'Whatever the fourth box asks, it was not a question you answered in ink.',
  },
  {
    id: 'lore_canal_survey',
    category: LoreCategory.Alderbrook,
    name: 'Canal Survey, Third Revision',
    text:
      'The canal is measured to the inch along its whole length, and the figures agree ' +
      'with each other everywhere but the stretch behind Ashwick Row. There the third ' +
      'revision is eleven feet longer than the second. Nobody dug it. Somebody measured it again.',
  },
  {
    id: 'lore_standing_orders',
    category: LoreCategory.Watch,
    name: 'Standing Orders, Rain-Damaged',
    text:
      'Most of it is procedure a constable already knows: doorways, whistles, who goes first. ' +
      'The last paragraph is in a different hand and much newer. It says that if the record ' +
      'and the street disagree, you are to write down the street, and then go home.',
  },
  {
    id: 'lore_ledger_page',
    category: LoreCategory.Index,
    name: 'A Page From a Ledger',
    text:
      'Two columns, dated across four years. On the left, names. On the right, the same ' +
      'names again, spelled a little differently each time, drifting a letter a year. ' +
      'The last few entries on the right are not names any more.',
  },
  {
    id: 'lore_lamplighters_round',
    category: LoreCategory.Alderbrook,
    name: "Lamplighter's Round",
    text:
      'A list of every lamp between the Weir and the Outer Index, in the order they are lit, ' +
      'with the time beside each. It has been kept faithfully for eleven years. ' +
      'Four of the lamps on it have never existed.',
  },
]);

/** Every id, for the fixtures and the guards. One derivation, never a second list. */
export const LORE_IDS: readonly string[] = Object.freeze(LORE.map((note) => note.id));

/**
 * One note, or undefined.
 *
 * A MAP RATHER THAN A `find`, because `learnLore` is called from the pickup path
 * and `projectLore` runs per viewer per frame — and because a linear scan over a
 * frozen table is the kind of thing that is fine at five entries and is not
 * noticed when it becomes fifty.
 */
const BY_ID = new Map<string, Lore>(LORE.map((note) => [note.id, note]));

export function loreById(id: string): Lore | undefined {
  return BY_ID.get(id);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A NOTE ON THE FLOOR IS AN ITEM ID THAT IS NOT AN ITEM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is `content/money.ts`'s shape, taken deliberately and for its exact
 * reason. That file says it best: *"AN `Item` HAS A `slot`. A coin pile does
 * not, and giving it one — Trinket, say, because something has to go there —
 * would put a lie in the catalogue that the equip path, the paper doll and
 * `wornOf` would each have to be taught to ignore."*
 *
 * ═══ IT WAS BUILT THE OTHER WAY FIRST, AND THE GUARDS SAID NO ═══
 * The first attempt put five notes in `ITEMS` with a shared icon. Seven tests
 * failed at once and every one of them was right: the catalogue asserts that an
 * item is WORN OR DRUNK, that icons are unique, and that the three tiers line up
 * with the three drop tables. A note is a fourth kind of thing and none of those
 * invariants wanted relaxing — they wanted the note to not be an item.
 *
 * ═══ WHAT IT BUYS, BESIDES HONESTY ═══
 * No slot, no ego (`resolveItem` never sees it), no bag entry, no shop row, and
 * NO ART: the floor draws one shared `ui_tile_marker_loot` tinted by tier, so a
 * note needs no sprite of its own and a bare clone renders it correctly today.
 *
 * The id travels every path an item id travels — `addGroundItem`, the wire, the
 * pile — because all of them take a string. Only the four places that must know
 * the difference ask, and they ask BEFORE `resolveItem`, exactly as they do for
 * money.
 */
const NOTE_PREFIX = 'note@';

/** The floor id for a note. One direction, so the two can never drift. */
export function noteIdFor(loreId: string): string {
  return `${NOTE_PREFIX}${loreId}`;
}

/**
 * The lore id inside a floor id, or undefined for anything else.
 *
 * ANSWERS `undefined` RATHER THAN THROWING, because every caller is asking "is
 * this one of mine?" about a string that arrived from the world — the same
 * contract `moneyAmountOf` keeps, and it is what lets the pickup path ask
 * without a second `isNoteId` call first.
 */
export function loreIdOfNote(id: string): string | undefined {
  if (!id.startsWith(NOTE_PREFIX)) return undefined;
  const loreId = id.slice(NOTE_PREFIX.length);
  // AND IT HAS TO NAME A NOTE THIS BUILD SHIPS. A content reload that dropped a
  // note leaves ids on live floors; answering undefined sends them down the
  // ordinary item path, where `resolveItem` fails and the row is dropped with a
  // sentence — which is the behaviour that path already has for a deleted item.
  return BY_ID.has(loreId) ? loreId : undefined;
}
