/**
 * The hotbar: ONE row of identical slots, each holding a class talent, a bound
 * item or nothing, a 32x32 icon inside a 44x44 frame.
 *
 * ===========================================================================
 * IT USED TO BE TWO HALVES IN ONE STRIP. IT IS ONE BAR NOW.
 * ===========================================================================
 * The old header described *"EIGHT slots — four class talents on keys 1-4, then
 * four ITEM slots that are mouse-only"*, later nine and four. That partition is
 * gone, on the author's report: *"the hotbar/actionbar should not segregate
 * items from abilities. we need it it be 1 bar to rearange as people like."*
 * The argument the partition rested on is answered where it was made — see
 * `HOTBAR_SLOT_POOL` — rather than deleted, because the argument was sound and
 * it was its premise that moved.
 *
 * WHAT SURVIVED THE CHANGE, because it was right for its own reason and the
 * reason has not moved:
 *
 *   THE BAR IS NEVER SORTED HERE. It draws the slots it is GIVEN, in the order
 *   it is given them. Muscle memory for which key is Ward Rush is worth more
 *   than any ordering a renderer could impose, and a hotbar that re-sorted by
 *   cooldown would move the buttons around mid-fight.
 *
 *   A SLOT'S CONTENTS ARE NEVER REMEMBERED BY THIS FILE. An item slot's caption
 *   is recomputed from the last `inventory` frame on every draw
 *   (`itemSlotAction`), and a talent slot is resolved from the loadout by its
 *   caller. That is what makes an item equipped from the PANEL flip the caption
 *   on the BAR one frame later with nothing wired between them.
 *
 *   EVERY SLOT NOW HAS A KEY, which is the one thing the partition cost. Slots
 *   0-8 are `1`..`9` and slots 9-17 are `⇧1`..`⇧9` — see `hotbarKeyLabel`,
 *   which the painter and the press both read so the printed key and the sent
 *   key cannot disagree.
 *
 * PORTED, WITH CITATIONS. Upstream's bar holds two kinds of thing in one row of
 * identical boxes: HotkeysIconsDisplay.lua:159-162 tags each occupied slot
 * `"talent"` or `"inventory"` off the same `a.hotkey[j]` table, and :349 accepts
 * a drop of either kind onto any slot. Everything below that is per-kind
 * drawing, which is exactly the shape this file now has.
 *
 * ===========================================================================
 * WHAT AN ITEM ON THE BAR DOES: IT EQUIPS, REMOVES, OR IS DRUNK.
 * ===========================================================================
 * THIS SECTION SAID "THERE IS NO USE-ITEM VERB" AND CONTRADICTED ITS OWN FILE.
 * It listed the client→server vocabulary, concluded "there is no `use`, no
 * `activate`, no `consume` — and nothing to invoke one on ... all 22 authored
 * items are passive", and argued that shipping a `use` intent would be "a verb
 * with nothing behind it".
 *
 * Every clause of that has since gone: `UseSchema` is on the wire (`t: 'use'`),
 * the Draught of Mending restores forty hit points, and `ItemSlotAction.Use`
 * THREE HUNDRED LINES BELOW routes a bound draught to it — added because this
 * bar "captioned a draught EQUIP and sent an intent the server answers with
 * *that is not something you can wear*". The fix landed in the body and the
 * header kept explaining why it could not exist.
 *
 * So a bound item slot is a QUICK-SWAP for anything wearable, and a drink for
 * anything not:
 *
 *   in `carried`, has a slot  → caption EQUIP,  click sends `equip {itemId}`
 *   in `carried`, no slot     → caption USE,    click sends `use {itemId}`
 *   in `equipped`             → caption REMOVE, click sends `unequip {slot}`
 *   in neither                → caption GONE,   click clears the binding
 *
 * `CarriedItemView.slot` is the whole test, and it was put there for exactly
 * this — see `ItemSlotAction`.
 *
 * The flip between the first two is computed, never remembered — see
 * `itemSlotAction`. Upstream agrees a wearable is not a "use": tome/class/Object.lua:169-173
 * answers "This object has no usable power." for anything with no activatable,
 * and HotkeysIconsDisplay.lua:232-234 draws a bound object that is currently
 * `o.wielded` in a DIFFERENT frame from one sitting in the pack, which is the
 * same two-state distinction EQUIP/REMOVE draws. AND THE DEVIATION THAT USED TO
 * BE LABELLED HERE IS GONE: this read "upstream's inventory hotkey routes to
 * `playerUseItem` (PlayerHotkeys.lua:173-181); ours routes to equip/unequip,
 * because we have no usable objects to route to". We have one, and ours routes
 * there too now — :173-181 is ported rather than deviated from.
 *
 * THE DANGLING BINDING IS UPSTREAM'S OWN CASE, not an invention:
 * PlayerHotkeys.lua:176-177 pops "You do not have any <name>." when the bound
 * object is gone, and HotkeysIconsDisplay.lua:203-206 greys the slot
 * (`frame = "disabled"`) the moment the count reaches zero. GONE is both of
 * those.
 *
 * ===========================================================================
 * THE COOLDOWN WIPE IS DRAWN, NOT BLITTED
 * ===========================================================================
 * A canvas wedge — `arc` from twelve o'clock, clockwise, at a fixed alpha over
 * the icon — plus the turns remaining as a number on top. Not an image asset,
 * for three reasons that all matter:
 *
 *   1. A cooldown is a FRACTION of `LoadoutTalent.cooldownTurns`, and a 5-turn
 *      talent at 2 turns left is 40%. Art would need a frame per step per
 *      talent, or one generic wipe that lies about every talent whose cooldown
 *      is not the length the art assumed.
 *   2. It steps once per GAME TURN, because that is when the number actually
 *      changes. There is no animation and there must not be one: a smoothly
 *      sweeping wedge implies a continuous quantity and this one is discrete, so
 *      a sweep would be an animation lying about arithmetic — and PLAN.md § 10
 *      lists animation playback under Never.
 *   3. The NUMBER is the real signal and the wedge is the glanceable one. Both
 *      are drawn, always, so nobody has to count pixels of arc to know whether
 *      Mend Wounds comes back this turn or next.
 *
 * ===========================================================================
 * DISABLED IS A HATCH, NOT A TINT — AND EVERY STATE ALSO SAYS ITS NAME
 * ===========================================================================
 * `ui_hotbar_slot_disabled` already carries a diagonal hatch across the frame,
 * and that is why the disabled state uses the art instead of drawing the idle
 * frame darker. State is never signalled by colour alone here — the same rule
 * that gives the turn chips four silhouettes and the pips three. A TALENT slot
 * is disabled when the cooldown is live OR the resource is short, and both cases
 * additionally say so in words: the wipe carries digits, and the cost readout
 * turns from BONE to ORANGE when it cannot be paid. An ITEM slot says its state
 * in a word outright — EQUIP, REMOVE, GONE — and an EMPTY one says ITEM (or
 * BIND, while a drop would land).
 *
 * THAT CAPTION IS ALSO THE ONLY THING A BARE CLONE EVER SEES. client/public/
 * assets/ is gitignored in its entirety (ASSETS-LICENSE.md), so on a fresh
 * checkout `sprites.sprite()` resolves NOTHING and every path below falls back
 * to primitives. There is no state in this file whose fallback is a blank box:
 * a border is always traced and a word is always drawn.
 *
 * ALL OF IT IS ADVISORY. Affordability is computed here from the last `resource`
 * frame purely so the button can be greyed; the server re-checks the cost and
 * the cooldown on arrival and answers with `no_resource` or `on_cooldown`. A
 * greyed slot still sends its frame if the key is pressed — see main.ts. A
 * client that refuses to send is a client with a second copy of the rules, and
 * the moment the two disagree the player is holding a button that does nothing
 * and cannot be told why.
 *
 * IT DRAWS INTO THE BACKBUFFER through `Scene.hud`, at logical scale, exactly
 * like the party strip — so the frames are magnified by the same integer factor
 * as the world and sit on the same pixel grid. See the long note at the top of
 * render/canvas.ts.
 */

import { cardStatLines, wrapText } from './panel.ts';
import type { HoverCard, PanelRect } from './panel.ts';
import { TALENTS_PER_CLASS_MAX } from '../../shared/progression.ts';
import { PALETTE } from '../render/canvas.ts';
import { SLOT_ORDER } from '../../shared/protocol.ts';
import { DragKind } from './drag.ts';
import { PANEL_PAD, PanelSkin, drawPanel } from './panel.ts';
import { resourceLabel } from './resource.ts';
import type { DragSubject, PanelSize } from './drag.ts';
import type { LoadoutTalent, ResourceKind, Slot } from '../../shared/protocol.ts';
import type { SpriteSource } from '../render/assets.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SLOT, AND IT IS NO LONGER TIED TO A 72-PIXEL PNG.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This used to read 72, under a note headed "THIS NUMBER IS AN ART CONTRACT AND
 * MAY NOT BE SHRUNK": `ui_hotbar_slot_*` are 72x72, `drawFrame` blitted at the
 * sprite's own size and ignored the rect it was handed, so a smaller number
 * left a 72-pixel PICTURE over a smaller HIT BOX and clicks along two edges
 * landed on the map. The only levers left were the pad and the label strip, and
 * both were already spent on an earlier request to make the bar smaller.
 *
 * That note was right about the blit and wrong about the conclusion. THE
 * CONSTRAINT WAS THE BLIT, NOT THE ART. `ui_panel_9slice_inset` is a 48x48
 * NINE-SLICE with 16-pixel corners and `ui/panel.ts` already draws it at any
 * requested size — that is the entire point of a nine-slice, and the Case Log
 * has been wearing one all along. Corners are blitted 1:1 and only the flat
 * edges and centre stretch, so nothing is resampled and the frame is crisp at
 * 44 exactly as it is at 480.
 *
 * ═══ 88 LOGICAL PIXELS OF A 480-PIXEL VIEWPORT WAS EIGHTEEN PER CENT ═══
 * Reported twice from play, the second time as "massive and covers a LOT of
 * screen space". The row is now 60 tall and 380 wide instead of 88 and 604 —
 * two and a half tile rows of world handed back.
 *
 * 44 AND NOT LESS: a 16-pixel corner needs 32 before the corners meet, and the
 * icon inside wants 32 (below). 44 leaves a six-pixel margin all round, which is
 * what stops the art reading as a sticker on a box.
 */
export const SLOT_PX = 44;
/**
 * How big an icon is DRAWN in a slot.
 *
 * `icon_active_*` and `item_*` are all authored at 64, and this is exactly
 * half. A 2:1 reduction with smoothing off — which the whole backbuffer already
 * has — takes every other pixel, so it stays sharp rather than blurring; it is
 * not the fractional resample the old 72-pixel art contract existed to refuse.
 * The ratio is fixed here by construction rather than falling out of whatever
 * size a slot happens to be, which is the part that made the old rule right.
 */
const ICON_DRAW_PX = 32;

const SLOT_GAP = 4;
/**
 * How far the icon sits inside the frame. `(44 - 32) / 2` — stated as the
 * arithmetic so it follows the two constants rather than being a third number
 * that has to be kept in step with them.
 */
const ICON_INSET = Math.floor((SLOT_PX - ICON_DRAW_PX) / 2);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE BAR. EVERY SLOT TAKES EITHER KIND, AND THE KEY FOLLOWS THE POSITION.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THIS USED TO BE FOUR CONSTANTS DESCRIBING TWO HALVES: `HOTBAR_TALENT_SLOTS`
 * (nine, keyed), `HOTBAR_TALENT_PAGES` (two, swapped by Shift),
 * `HOTBAR_TALENT_BINDINGS` and `HOTBAR_ITEM_SLOTS` (four, mouse-only, appended
 * after the talents). The split is gone, on the author's report: *"the
 * hotbar/actionbar should not segregate items from abilities. we need it it be
 * 1 bar to rearange as people like."*
 *
 * ═══ THE OLD ARGUMENT FOR THE SPLIT, AND WHY IT NO LONGER HOLDS ═══
 * `HOTBAR_ITEM_SLOTS` carried it in full and it was a good argument for as long
 * as its premise stood: *"THE LIVE REASON IS THAT THERE ARE NO DIGITS LEFT.
 * Nine talent slots take `Digit1`..`Digit9`, and `Digit0` is not a tenth in any
 * sane reading of a row that starts at 1. What remains is punctuation or a
 * modifier, and both are worse than a mouse."*
 *
 * The premise was that the digits were SPENT ON TALENTS. They were not spent on
 * talents — they were spent on POSITIONS, and it was the bar that decided a
 * position could only hold a talent. Shift was already the second row of
 * positions (`HOTBAR_TALENT_PAGES`, and `scroll_back`'s note in keymap.ts calls
 * Shift *"the other lane"* the house rule). So there are EIGHTEEN keyed
 * positions, not nine, and once a position takes either kind every slot on the
 * bar has a key — which is strictly more than the old split could give, and the
 * opposite of what the old note concluded from the same facts.
 *
 * THE MOUSE-ONLY DECISION IS THEREFORE REVERSED RATHER THAN OVERRULED: nothing
 * about the keyboard changed, the reading of it did.
 *
 * ═══ AND THIS IS UPSTREAM'S OWN SHAPE, WHICH THE OLD HEADER ALREADY CITED ═══
 * `HotkeysIconsDisplay.lua:159-162` tags each occupied slot `"talent"` or
 * `"inventory"` off ONE `a.hotkey[j]` table, and `:349` accepts a drop of
 * either kind onto any slot. `PlayerHotkeys.lua:104-155` (`addNewHotkey`) walks
 * that one table for the first free index whichever kind is being placed. Ours
 * was the same file's drawing with a partition upstream does not have.
 */

/**
 * How many slots one press of the digit row addresses. NINE, and it is the
 * DIGITS that choose it: `Digit1`..`Digit9` are bound by CODE in
 * input/keymap.ts, so none of them can be reached from the numpad and
 * `move_north`'s Numpad8 is untouched. `Digit0` is not a tenth in any sane
 * reading of a row that starts at 1.
 */
export const HOTBAR_KEY_ROW = 9;

/**
 * How many rows of digits there are: the plain one and the Shifted one.
 *
 * SHIFT IS NOT A PAGE ANY MORE. It used to swap which nine talents the nine
 * boxes drew, which is why a `page` was a mode the drawing, the hit test, the
 * bind and the unbind all had to resolve through. The bar can now BE eighteen
 * boxes, so Shift reaches the second nine instead of replacing the first nine —
 * the picture never changes under the player's hand, which was the one thing a
 * paged bar could always get wrong.
 */
export const HOTBAR_KEY_ROWS = 2;

/**
 * Every slot a character can address. Derived, so the two above cannot drift
 * from it.
 *
 * IT IS ALSO THE POOL. Upstream's is `12 * nb_hotkey_pages` — sixty
 * (`PlayerHotkeys.lua:33`, and the same expression at :94, :125, :149 and
 * :212) — and every one of those sixty has a key. Ours is the same rule with
 * our key row: the pool is exactly what the keyboard can reach, so no slot in
 * it is ever a box with no way to press it.
 */
export const HOTBAR_SLOT_POOL = HOTBAR_KEY_ROW * HOTBAR_KEY_ROWS;

/**
 * How many slots a bar has before anybody touches the cogwheel or the grip.
 *
 * `HOTBAR_SLOTS_DEFAULT` is 13, which is EXACTLY THE BAR THAT SHIPPED: nine
 * talent boxes and four item boxes. Day one is unchanged to the pixel, which is
 * the property that lets a bar with a different model land without a word to
 * anybody playing — and `hotbarRowWidth(13)` is 620, twenty pixels inside the
 * 640 logical floor (`HUD_MIN_W`, render/canvas.ts), so the whole row is still
 * on one line at the smallest viewport this client can produce.
 */
export const HOTBAR_SLOTS_DEFAULT = 13;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BAR MUST BE ABLE TO ADDRESS EVERY TALENT A CLASS MAY OWN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `TALENTS_PER_CLASS_MAX` is the rule (src/shared/progression.ts); this is the
 * bar's answer to it. Shrinking the key row, or dropping to one row, would
 * leave a class holding actives no key could reach — a talent a player owns,
 * can see in the panel, and can never press. That is silent: nothing throws.
 *
 * IT IS THE POOL THAT MUST COVER IT, NOT THE VISIBLE COUNT. A player may set
 * the bar to one slot; that is a choice they made and can undo, and the talent
 * is still in the store and still on its key. What may never happen is a talent
 * with no ADDRESS at all.
 *
 * A TYPE-LEVEL ASSERTION rather than a runtime one, so it costs nothing at
 * runtime and fails at the only moment it matters — the commit that changes
 * either number.
 */
type _BarAddressesEveryTalent = typeof HOTBAR_SLOT_POOL extends number
  ? typeof TALENTS_PER_CLASS_MAX extends number
    ? true
    : never
  : never;
const _barCoversTheClass: _BarAddressesEveryTalent = true;
if (HOTBAR_SLOT_POOL < TALENTS_PER_CLASS_MAX || !_barCoversTheClass) {
  throw new Error(
    `hotbar: ${String(HOTBAR_SLOT_POOL)} slots cannot address ` +
      `${String(TALENTS_PER_CLASS_MAX)} talents — see TALENTS_PER_CLASS_MAX`,
  );
}

/**
 * The key printed on slot `index`, or null when the pool does not reach it.
 *
 * ═══ ONE COPY, READ BY THE PAINTER AND BY THE PRESS ═══
 * `main.ts`'s `onSlot` turns a digit and a Shift state back into an index with
 * the same arithmetic inverted, and a bar that PRINTED one key while SENDING
 * another is the single worst failure a hotbar has — it does not look broken,
 * it just casts the wrong thing. So the label is derived here and the inverse
 * is named after it.
 *
 * `⇧` RATHER THAN THE WORD. The glyph fits the five pixels a 44-slot's corner
 * has, and it is the one every keyboard legend uses.
 */
export function hotbarKeyLabel(index: number): string | null {
  if (index < 0 || index >= HOTBAR_SLOT_POOL) return null;
  const digit = (index % HOTBAR_KEY_ROW) + 1;
  return index < HOTBAR_KEY_ROW ? `${String(digit)}` : `⇧${String(digit)}`;
}

/**
 * Which slot a digit press means. The inverse of `hotbarKeyLabel`, and the
 * reason that one is a function rather than a template string at the paint.
 *
 * `digit` IS ZERO-BASED — key `1` is 0 — because that is what `onSlot` already
 * hands out, and converting in two places is how the two ends of one mapping
 * come to disagree.
 */
export function hotbarSlotForKey(digit: number, shifted: boolean): number {
  return (shifted ? HOTBAR_KEY_ROW : 0) + digit;
}

/** How dark the cooldown wedge goes. Dark enough to read, light enough to identify the icon. */
const WIPE_ALPHA = 0.72;
/** Half the diagonal of a 64px square, rounded up: the wedge must cover the corners. */
const WIPE_RADIUS = 46;

/** How far above the bottom edge of a slot its caption is centred. */
const CAPTION_BASELINE = 9;

const FONT_KEY = 'bold 10px ui-monospace, Consolas, monospace';
const FONT_COST = '10px ui-monospace, Consolas, monospace';
const FONT_WIPE = 'bold 14px ui-monospace, Consolas, monospace';
const FONT_NAME = '10px ui-monospace, Consolas, monospace';
const FONT_CAPTION = 'bold 10px ui-monospace, Consolas, monospace';

/**
 * EVERY SPRITE ID THIS FILE NAMES, AS A LITERAL, IN ONE PLACE.
 *
 * All six are already in the manifest and already loaded — `ui_hotbar_slot_`,
 * `ui_inventory_cell_` and `item_`/`icon_active_` are all on main.ts's
 * `NEEDED_ASSET_PREFIXES`, which test/client/assets.test.ts:231-249 pins exactly.
 * NO NEW ID IS INVENTED HERE and none may be: a prefix does not create a PNG,
 * and art nobody has cut resolves to the loud violet missing-asset box on every
 * clone, for a feature that otherwise works.
 */
/**
 * WHAT A SLOT'S FRAME IS SAYING. Three states, exactly the three the retired
 * `ui_hotbar_slot_*` PNGs carried — the set is unchanged, only the way it is
 * drawn is. See `drawFrame`.
 */
const FrameState = {
  Idle: 'idle',
  Hover: 'hover',
  Disabled: 'disabled',
} as const;
type FrameState = (typeof FrameState)[keyof typeof FrameState];

/**
 * WHAT A SLOT IS. Three kinds, and the set is closed.
 *
 * `as const` object plus a derived type, never an `enum`: the server type-strips
 * `src/**` and runs it directly, so `erasableSyntaxOnly` is on (CLAUDE.md § 1).
 * Same shape as `Slot`, `DragKind`, `PanelSkin` and every other closed set here.
 */
export const HotbarSlotKind = {
  /** A class talent, on whichever slot it was put. */
  Talent: 'talent',
  /** A bound item, on whichever slot it was put. Keyed exactly as a talent is. */
  Item: 'item',
  /** A slot nobody has bound yet — a drop target, not a gap. */
  Empty: 'empty',
} as const;
export type HotbarSlotKind = (typeof HotbarSlotKind)[keyof typeof HotbarSlotKind];

/**
 * What clicking a bound item slot WOULD DO, right now.
 *
 * COMPUTED FROM THE LAST `inventory` FRAME, NEVER REMEMBERED — see
 * `itemSlotAction`. A binding stores an `itemId` and nothing else; whether that
 * id is currently in the bag, on the body or gone entirely is a property of the
 * world, and a slot that cached "this equips" would keep saying so after the
 * item was already worn.
 */
export const ItemSlotAction = {
  /** The item is in `carried`. Click sends `equip {itemId}` (protocol.ts:1905-1909). */
  Equip: 'equip',
  /** The item is worn. Click sends `unequip {slot}` (protocol.ts:1938-1942). */
  Unequip: 'unequip',
  /**
   * The item is carried and CANNOT be worn — a draught, a flare. Click sends
   * `use {itemId}` (protocol.ts's `UseSchema`).
   *
   * `CarriedItemView.slot` is the whole test, and it was put there for this:
   * *"ABSENT ON A CONSUMABLE, which is also how the client knows not to offer
   * 'Equip' for it"*. The inventory panel already made that check; this bar did
   * not, so it captioned a draught EQUIP and sent an intent the server answers
   * with "that is not something you can wear".
   */
  Use: 'use',
  /**
   * The item is in neither collection: dropped, destroyed, or never held.
   * PlayerHotkeys.lua:176-177 is the same case upstream, and it does not silently
   * do nothing either — it says "You do not have any <name>."
   */
  Gone: 'gone',
} as const;
export type ItemSlotAction = (typeof ItemSlotAction)[keyof typeof ItemSlotAction];

/**
 * A class talent on a slot. Assembled by main.ts from three separate frames.
 *
 * ═══ THE DISCRIMINANT IS REQUIRED, AS IT IS ON THE OTHER TWO MEMBERS ═══
 * It was optional for exactly one pass, as a written-down shim: this file grew
 * two more slot kinds while main.ts was still building the four talent slots as
 * bare `{talent, cooldown, affordable}` literals, and the two files ship in
 * different work items. main.ts:2261 now spells
 * `kind: HotbarSlotKind.Talent` at the construction site, so the `?` and the four
 * `case undefined:` arms that went with it are gone.
 *
 * WHY IT MATTERED ENOUGH TO CHASE. An optional discriminant means the compiler
 * accepts a talent slot with no `kind` FOREVER, and each exhaustive switch below
 * had a live `case undefined:` routing that into the talent branch — so the one
 * guarantee that made the shim safe ("the compiler will say so") could never
 * fire, because nothing was left for it to say. `switch-exhaustiveness-check`
 * cannot flag a dead arm; only removing it can.
 */
export type HotbarTalentSlot = {
  readonly kind: typeof HotbarSlotKind.Talent;
  readonly talent: LoadoutTalent;
  /** GAME TURNS remaining. 0 is ready — the `cooldowns` frame omits ready talents. */
  readonly cooldown: number;
  /** Advisory: the last `resource` frame says this is payable. */
  readonly affordable: boolean;
};

/** A bound item on a slot. */
export type HotbarItemSlot = {
  readonly kind: typeof HotbarSlotKind.Item;
  /** The binding itself. The only thing that is remembered between frames. */
  readonly itemId: string;
  /** For the initials fallback and for the strip under the row. */
  readonly name: string;
  /** An `item_*` asset key, never a path — the client owns the manifest. */
  readonly icon: string;
  /** Recomputed every frame by `itemSlotAction`. */
  readonly action: ItemSlotAction;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT IT IS AND WHAT IT WOULD CHANGE — the same two the bag's card shows.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `hotbarTipAt` returned `{ title, meta, lines: [] }` for an item: a name and
   * the word "drink". The bar is where a consumable actually gets used, so it
   * was the one surface that named a thing without ever saying what it does —
   * and the draught's whole sentence, the one written against THIS body's
   * Constitution, was already on the wire and read by the panel next door.
   *
   * Passed in rather than resolved here, for this file's standing rule: the
   * hotbar does not hold the inventory frame and must not learn to. main.ts
   * joins them at the construction site, where `carried` is already in hand for
   * `itemSlotAction`.
   *
   * Optional, so a caller that has no inventory frame yet builds the slot it
   * always built.
   */
  readonly desc?: string;
  readonly rows?: readonly { readonly label: string; readonly value: string }[];
};

/** A slot with nothing in it. Still a slot, still a drop target. */
export type HotbarEmptySlot = {
  readonly kind: typeof HotbarSlotKind.Empty;
};

export type HotbarSlot = HotbarTalentSlot | HotbarItemSlot | HotbarEmptySlot;

export type HotbarView = {
  /** In server order. Never sorted here. Empty until `loadout` arrives. */
  readonly slots: readonly HotbarSlot[];
  /** Index under the pointer, or -1. */
  readonly hovered: number;
  /** Index currently in targeting mode, or -1. */
  readonly armed: number;
  /**
   * ════════════════════════════════════════════════════════════════════════
   * WHICH POOL THIS BODY SPENDS — the tooltip said `resolve` to EVERYONE.
   * ════════════════════════════════════════════════════════════════════════
   * The cost clause was a hard-coded string, so an Alchemist hovering
   * Concussion Flask read *"2 resolve"* over a description that said "2
   * Reagents" — one card naming two different pools, neither of which the
   * Watchman's word describes for three of the four classes.
   *
   * OPTIONAL, like `page` above and for its reason: every fixture that
   * builds a view by hand keeps compiling. ABSENT OMITS THE CLAUSE rather
   * than falling back to a word, because the fallback IS the bug — a
   * tooltip that says nothing about the cost is recoverable, and one that
   * confidently names the wrong pool is what shipped.
   */
  readonly pool?: ResourceKind;
  /**
   * The drag in flight, if any — so an empty slot can light up while something
   * droppable is being carried over the bar.
   *
   * STILL OPTIONAL, AND NOW FOR A REASON RATHER THAN AS A SHIM. main.ts's
   * `hotbarView` (main.ts:2255) passes `drag: liveDragSubject()` and has
   * done since the wiring pass, so the degraded path is no longer what ships — but
   * unlike `HotbarTalentSlot.kind` this field is not a DISCRIMINANT. Nothing
   * narrows on it, omitting it costs exactly one cosmetic frame swap on empty
   * slots, and every other caller of `drawHotbar` in the suite is a fixture that
   * has no drag to report. Requiring it would make `drag: null` boilerplate in
   * thirty test cases to buy nothing the compiler can check.
   */
  readonly drag?: DragSubject | null;
  /**
   * ════════════════════════════════════════════════════════════════════════
   * HOW MANY BOUND SLOTS ARE PAST THE END OF THE BAR. The shrink's receipt.
   * ════════════════════════════════════════════════════════════════════════
   *
   * Shrinking the bar HIDES buttons and never erases them — `HotbarStyle.slots`
   * argues that at length, and it is upstream's behaviour exactly
   * (`HotkeysIconsDisplay` stops laying out at `:270`/`:276` and leaves
   * `a.hotkey` alone). The trouble is that it was true and entirely UNSAID: a
   * player who dragged the grip in and watched four buttons vanish has no way
   * to tell "hidden, drag it back" from "gone, bind them again", and the
   * conservative reading of a disappearing button is the wrong one.
   *
   * SO THE BAR SAYS IT ITSELF, in the header strip it already owns, and only
   * when the pointer is not on a slot — see `stripFor`. It is a number and not
   * a warning: nothing has gone wrong, and an ORANGE line about a thing the
   * player just did on purpose would read as a refusal.
   *
   * OPTIONAL, like `drag` and `pool` above and for their reason: every fixture
   * that builds a view by hand keeps compiling, and absent means "nothing to
   * report" rather than "unknown" — which is the honest default, because a
   * caller that does not count cannot have any.
   */
  readonly hidden?: number;
};

export type HotbarOptions = {
  readonly ctx: CanvasRenderingContext2D;
  readonly sprites: SpriteSource;
  readonly view: HotbarView;
  /** The bar's outer rect, in logical backbuffer pixels. See `hotbarPanelSize`. */
  readonly rect: PanelRect;
  /** What its cogwheel set. The default when absent. */
  readonly style?: HotbarStyle;
};

export type SlotRect = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

// ---------------------------------------------------------------------------
// GEOMETRY — one copy, read by the painter, the hit test and the drop test
// ---------------------------------------------------------------------------

/** How wide a row of `count` slots is, gaps included. */
export function hotbarRowWidth(count: number): number {
  return count * SLOT_PX + Math.max(0, count - 1) * SLOT_GAP;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BAR IS A PANEL, AND ITS WIDTH IS THE PLAYER'S.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reported: the bar was a strip the width of the screen with the slots centred
 * in it, which left bare wings at both sides of every window wider than the row.
 * It is its own panel now, framed like the case log, moved by any part of it
 * that is not a slot and resized from its corner grip.
 *
 * ═══ A NARROW BAR WRAPS, AS UPSTREAM'S HOTKEY BOX DOES ═══
 * `HotkeysIconsDisplay` fits as many columns as its box is wide
 * (engine/HotkeysIconsDisplay.lua:108-109) and starts a new row when one fills
 * (:265-271). So the grip chooses how many slots sit on a line, and the height
 * follows. This replaced `hotbarVisibleCount`, which hid the item slots, or the
 * whole bar, on a window narrower than the row. A wrapped bar hides nothing.
 */

/** The frame around the slots: `panelInner`'s inset, so the skin's border clears them. */
export const HOTBAR_INSET = PANEL_PAD + 3;

/** The strip over the slots: what the pointer is on, and a handle to move the bar by. */
export const HOTBAR_HEADER_H = 12;

/**
 * The bar's height on one line, which main.ts's panel bands leave free at the
 * foot of the screen so a docked panel is not drawn over it by default.
 *
 * DERIVED, NEVER TYPED OUT. `panelBand` subtracts this from the viewport height,
 * so a change to any term reaches every draggable panel with no edit anywhere
 * else, and would reach them wrongly if anybody wrote the number down twice.
 */
export const HOTBAR_TOTAL_H = HOTBAR_INSET * 2 + HOTBAR_HEADER_H + SLOT_PX;

/** The narrowest bar: one slot a line. The grip stops here. */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW THE BAR IS DRAWN — the three things its cogwheel sets.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Asked for: the bar's own settings button, like the case log's, with a setting
 * to stand it on end along with the others. Upstream's own options for its
 * hotkey bar are the icon size, "From 32 to 64" (GameOptions.lua:307), and its
 * box lays icons out row by row or column by column
 * (engine/HotkeysIconsDisplay.lua:265-278). Those two, and the case log's fade.
 *
 * VALUES, NOT STEP INDICES, for `logStyleSchema`'s reason: a stored 48 is still
 * 48 the day a step is added.
 */
export type HotbarStyle = {
  /** Column by column rather than row by row: upstream's box docked on a side. */
  readonly vertical: boolean;
  /** The icon's size in logical pixels. The slot, its gap and its art scale with it. */
  readonly icon: number;
  /** Backing opacity, as a percentage. The slots never fade. */
  readonly opacity: number;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * HOW MANY SLOTS THE BAR HAS. 1..`HOTBAR_SLOT_POOL`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Asked for twice, as two controls over one number: *"i want the cogwheel
   * settings button for the action bar to allow you to add more slots to
   * expand"* and *"resizing the actionbar should dynamically add slots to the
   * actionbar."* ONE number with two writers, never two numbers: a cogwheel
   * count and a dragged count would be two opinions about the same bar, and the
   * moment they disagreed the row would redraw itself out from under whichever
   * gesture was still in flight.
   *
   * IT LIVES ON THE STYLE AND NOT ON THE SIZE, although the grip writes it.
   * `hotbarSize` is where the player put the EDGES; this is what the bar HOLDS.
   * Deriving the count from the stored size on every draw would mean a bar that
   * silently gained a slot when the viewport got wider, which is the class of
   * surprise `PanelLayoutView.logSize` already refuses by storing the dragged
   * value rather than recomputing it.
   *
   * IT IS A COUNT, NOT A CAPACITY. The BINDINGS are `HOTBAR_SLOT_POOL` long
   * whatever this says, so shrinking the bar hides buttons and never erases
   * them — expand it again and everything is where it was left. That is
   * upstream's behaviour exactly: `HotkeysIconsDisplay` stops laying out when
   * it runs out of rows (`:270`, `:276`) and `a.hotkey` is untouched by it.
   */
  readonly slots: number;
};

const ICON_STEPS = [ICON_DRAW_PX, 48, 64] as const;
const ICON_NAMES = ['Normal', 'Large', 'Huge'] as const;
const FADE_STEPS = [40, 60, 80, 100] as const;

export const DEFAULT_HOTBAR_STYLE: HotbarStyle = {
  vertical: false,
  icon: ICON_DRAW_PX,
  opacity: 100,
  slots: HOTBAR_SLOTS_DEFAULT,
};

/** How much bigger than the drawn-at-32 slot this style's slot is. */
function scaleOf(style: HotbarStyle): number {
  return style.icon / ICON_DRAW_PX;
}

function slotPx(style: HotbarStyle): number {
  return Math.round(SLOT_PX * scaleOf(style));
}

function gapPx(style: HotbarStyle): number {
  return Math.round(SLOT_GAP * scaleOf(style));
}

/** How long a line of `n` slots is at this style, gaps included. */
function lineLength(n: number, style: HotbarStyle): number {
  return n * slotPx(style) + Math.max(0, n - 1) * gapPx(style);
}

/** The smallest bar at a style: one slot. The grip stops here. */
export function hotbarFloor(style: HotbarStyle = DEFAULT_HOTBAR_STYLE): PanelSize {
  const one = HOTBAR_INSET * 2 + slotPx(style);
  return { w: one, h: one + HOTBAR_HEADER_H };
}

/** How many slots sit on a line `along` pixels long: at least one, at most all. */
function perLine(along: number, count: number, style: HotbarStyle): number {
  const fits = Math.floor((along + gapPx(style)) / (slotPx(style) + gapPx(style)));
  return Math.max(1, Math.min(Math.max(1, count), fits));
}

/**
 * The bar's outer size for `count` slots: the width the player gave it
 * (`stored`, or the whole row when null), never wider than `maxW` and never
 * narrower than one slot, and the height its lines need. Only the stored WIDTH
 * is read — the height is always the lines'.
 */
export function hotbarPanelSize(
  count: number,
  stored: PanelSize | null,
  maxW: number,
  style: HotbarStyle = DEFAULT_HOTBAR_STYLE,
  maxH: number = Number.POSITIVE_INFINITY,
): PanelSize {
  // STOOD ON END, THE LENGTH IS THE HEIGHT: the grip's height chooses how many
  // slots run down a column, as its width chooses how many run along a row.
  const room = style.vertical
    ? Math.max(0, maxH - HOTBAR_INSET * 2 - HOTBAR_HEADER_H)
    : Math.max(0, maxW - HOTBAR_INSET * 2);
  const given = style.vertical
    ? (stored?.h ?? 0) - HOTBAR_INSET * 2 - HOTBAR_HEADER_H
    : (stored?.w ?? 0) - HOTBAR_INSET * 2;
  const across = perLine(stored === null ? room : Math.min(room, given), count, style);
  const lines = Math.max(1, Math.ceil(count / across));
  const long = lineLength(across, style);
  const wide = lineLength(lines, style);
  return style.vertical
    ? { w: HOTBAR_INSET * 2 + wide, h: HOTBAR_INSET * 2 + HOTBAR_HEADER_H + long }
    : { w: HOTBAR_INSET * 2 + long, h: HOTBAR_INSET * 2 + HOTBAR_HEADER_H + wide };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW MANY SLOTS A BAR THIS SIZE HOLDS. THE GRIP'S HALF OF THE COUNT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PORTED. `HotkeysIconsDisplay.lua:108-109` is the whole rule:
 *
 *     self.max_cols = math.floor(self.w / self.frames.w)
 *     self.max_rows = math.floor(self.h / self.frames.h)
 *
 * and the layout loop at `:265-278` walks the hotkey table filling columns
 * then rows and STOPS when it runs out of either (`if row >= self.max_rows then
 * return end`). So in upstream the size of the box decides how many of the
 * sixty slots are on screen, and that is precisely what was asked for:
 * *"resizing the actionbar should dynamically add slots to the actionbar. this
 * functionality should work like Tales of Maj Eyal."*
 *
 * ═══ ONE DIFFERENCE, AND IT IS THE GAP ═══
 * Upstream's `frames.w` is `icon_w + 8` — the pitch INCLUDES the padding on
 * both sides, so `floor(w / pitch)` is exact for it. Ours puts the gap BETWEEN
 * slots and not after the last one, so the same division is short by one
 * whenever the row ends flush. `perLine` already solves that (`(along + gap) /
 * (slot + gap)`) and is reused here rather than re-derived — two copies of a
 * fencepost is how a bar comes to disagree with itself about its own last box.
 *
 * ═══ AT LEAST ONE, AT MOST THE POOL ═══
 * A grip dragged into the corner leaves one slot rather than none: a bar with
 * no slots is a panel with a cogwheel and nothing to configure, and the player
 * would have to find the same grip again to get their game back. The ceiling is
 * the pool because a slot past it would have no key — see `HOTBAR_SLOT_POOL`.
 */
export function hotbarSlotsForSize(
  size: PanelSize,
  style: HotbarStyle = DEFAULT_HOTBAR_STYLE,
): number {
  const along = style.vertical
    ? size.h - HOTBAR_INSET * 2 - HOTBAR_HEADER_H
    : size.w - HOTBAR_INSET * 2;
  const across = style.vertical
    ? size.w - HOTBAR_INSET * 2
    : size.h - HOTBAR_INSET * 2 - HOTBAR_HEADER_H;
  const cols = perLine(along, HOTBAR_SLOT_POOL, style);
  const rows = perLine(across, HOTBAR_SLOT_POOL, style);
  return Math.max(1, Math.min(HOTBAR_SLOT_POOL, cols * rows));
}

/** The header strip: inside the frame, over the first line. */
export function hotbarHeaderRect(rect: PanelRect): PanelRect {
  return {
    x: rect.x + HOTBAR_INSET,
    y: rect.y + HOTBAR_INSET,
    w: Math.max(0, rect.w - HOTBAR_INSET * 2),
    h: HOTBAR_HEADER_H,
  };
}

/**
 * Where slot `index` sits in a bar drawn at `rect`.
 *
 * ONE function, used by the painter AND by the hit test, so a click can never
 * land on a slot other than the one under the pointer. Two copies of this
 * arithmetic is the classic way a UI acquires an off-by-four-pixels bug that
 * only shows up on somebody else's window size.
 */
export function slotRect(
  rect: PanelRect,
  index: number,
  count: number,
  style: HotbarStyle = DEFAULT_HOTBAR_STYLE,
): SlotRect {
  const across = style.vertical
    ? perLine(rect.h - HOTBAR_INSET * 2 - HOTBAR_HEADER_H, count, style)
    : perLine(rect.w - HOTBAR_INSET * 2, count, style);
  const along = index % across;
  const line = Math.floor(index / across);
  const pitch = slotPx(style) + gapPx(style);
  return {
    x: rect.x + HOTBAR_INSET + (style.vertical ? line : along) * pitch,
    y: rect.y + HOTBAR_INSET + HOTBAR_HEADER_H + (style.vertical ? along : line) * pitch,
    w: slotPx(style),
    h: slotPx(style),
  };
}

/**
 * Which slot a logical-backbuffer point is over, or -1, and -1 with no bar.
 *
 * Takes BACKBUFFER coordinates, not client ones: the caller converts once, using
 * the renderer's metrics, and everything downstream of that conversion works in
 * the one coordinate space the HUD is drawn in.
 *
 * ═══ `count` MUST BE THE SAME NUMBER `drawHotbar` SAW: `view.slots.length` ═══
 * The painter draws the slots it is GIVEN and this walks the `count` it is
 * given. A shorter count cannot reach a slot past its end, which is the safe way
 * round: a click that lands on nothing is visible, and one that fires the wrong
 * slot is not.
 */
export function hotbarSlotAt(
  rect: PanelRect | null,
  px: number,
  py: number,
  count: number,
  style: HotbarStyle = DEFAULT_HOTBAR_STYLE,
): number {
  if (rect === null) return -1;
  for (let i = 0; i < count; i += 1) {
    const r = slotRect(rect, i, count, style);
    if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) return i;
  }
  return -1;
}

/**
 * What a drop landing here means. Two answers, and the set is closed.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT USED TO HAVE THREE, AND THE THIRD WAS THE PARTITION.
 * ═══════════════════════════════════════════════════════════════════════════
 * `HotbarDropKind.Talent` meant "this half of the bar will not take what you
 * are carrying — refuse it IN WORDS", and it existed so that a player who
 * dragged a coat onto slot 2 was told *"the first four slots are your class
 * talents"* rather than watching the coat snap back for no stated reason. A
 * good answer to a question this bar no longer asks: every slot takes either
 * kind, so there is nothing left to refuse and nothing left to explain.
 *
 * `Miss` is still the genuinely empty answer: the release was not over the bar
 * at all, and whatever else is under the pointer gets it.
 *
 * ═══ THE CALLER STILL CHECKS THE DRAG, AND MUST ═══
 * `Bind` says a SLOT was hit, not that the thing in hand belongs in it. A
 * `Panel` or `Resize` drag can end over the bar and means nothing there; the
 * caller resolves the subject and writes the binding, exactly as before.
 *
 * Upstream registers a drop zone for EVERY slot, occupied or not, before it
 * branches on what is in one (HotkeysIconsDisplay.lua:167, outside the
 * `if ts then` at :169), and then filters by drag kind at :349. This is that,
 * with the filtering made into a value the caller must handle.
 */
export const HotbarDropKind = {
  /** A slot. The caller may bind, and a right-click here means UNBIND. */
  Bind: 'bind',
  /** Not over the bar. */
  Miss: 'miss',
} as const;
export type HotbarDropKind = (typeof HotbarDropKind)[keyof typeof HotbarDropKind];

export type HotbarDrop =
  | { readonly kind: typeof HotbarDropKind.Bind; readonly index: number }
  | { readonly kind: typeof HotbarDropKind.Miss };

/**
 * Which slot a release lands on.
 *
 * Same geometry as `hotbarSlotAt` — it literally calls it — so a drop can never
 * disagree with a hover about which box the pointer is in.
 */
export function hotbarDropTargetAt(
  rect: PanelRect | null,
  px: number,
  py: number,
  count: number,
  style: HotbarStyle = DEFAULT_HOTBAR_STYLE,
): HotbarDrop {
  const index = hotbarSlotAt(rect, px, py, count, style);
  return index < 0 ? { kind: HotbarDropKind.Miss } : { kind: HotbarDropKind.Bind, index };
}

// ---------------------------------------------------------------------------
// THE ITEM-SLOT STATE MACHINE — pure, exported, and the thing that stops a dead
// drop target
// ---------------------------------------------------------------------------

/** The one field either collection has to carry for the state machine to run. */
export type ItemIdentity = {
  readonly itemId: string;
  /**
   * WHERE IT WOULD GO, absent on a consumable — `CarriedItemView.slot`'s own
   * contract. Optional because the EQUIPPED map is keyed by slot already and
   * its values have nothing to add; it is the CARRIED list that needs to say
   * whether a thing can be worn at all.
   */
  readonly slot?: Slot;
};

/**
 * Which slot of the doll is wearing this item, or null.
 *
 * Exported because the caller NEEDS it: `unequip` takes a `Slot`, not an item id
 * (protocol.ts:1949 is `z.enum(SLOT_ORDER)`), so a REMOVE caption with no way to
 * name the slot would be a caption over a button that cannot send its intent —
 * the "control that does nothing" trap, one indirection deep.
 *
 * Walks `SLOT_ORDER` rather than `Object.keys`, so the answer is deterministic
 * and can only ever be a real `Slot`.
 */
export function wornSlotOf(
  itemId: string,
  equipped: Readonly<Partial<Record<Slot, ItemIdentity>>>,
): Slot | null {
  for (const slot of SLOT_ORDER) {
    if (equipped[slot]?.itemId === itemId) return slot;
  }
  return null;
}

/**
 * What a bound item slot would do RIGHT NOW, from the last `inventory` frame.
 *
 * ═══ PURE, AND THAT IS WHY IT IS A SEPARATE FUNCTION ═══
 * The wiring pass does nothing but hand this the two collections it already
 * holds, and this test suite drives the whole state machine without a DOM, a
 * canvas or a socket. The alternative — computing the caption inside the painter
 * — is how a drop target ends up drawing EQUIP over an item that is already
 * worn, which nobody notices until they click it and the server refuses.
 *
 * EQUIPPED IS CHECKED FIRST. The two collections are disjoint on every frame the
 * server sends, so the order is unobservable in practice; it is fixed anyway,
 * because if a desync ever did put one id in both, "it is on your body" is the
 * true half and REMOVE is the honest caption.
 *
 * THE FLIP NEEDS NO INPUT. An item that moves carried→equipped — by this slot,
 * by the inventory panel, by anything — reads `equip` on one frame and `unequip`
 * on the next with nothing remembered in between. That is the whole reason
 * nothing here is cached, and it is what HotkeysIconsDisplay.lua:232-234 does
 * with `o.wielded`: the bar asks the world, every draw.
 */
export function itemSlotAction(
  itemId: string,
  carried: readonly ItemIdentity[],
  equipped: Readonly<Partial<Record<Slot, ItemIdentity>>>,
): ItemSlotAction {
  if (wornSlotOf(itemId, equipped) !== null) return ItemSlotAction.Unequip;
  const held = carried.find((item) => item.itemId === itemId);
  if (held === undefined) return ItemSlotAction.Gone;
  // NO SLOT MEANS IT CANNOT BE WORN, which for this game means it is drunk or
  // thrown. See `ItemSlotAction.Use`.
  return held.slot === undefined ? ItemSlotAction.Use : ItemSlotAction.Equip;
}

// ---------------------------------------------------------------------------
// STATE → PICTURE
// ---------------------------------------------------------------------------

/**
 * A slot is DEAD when pressing it cannot accomplish anything.
 *
 * Exhaustive over the union on purpose. An EMPTY slot is NOT dead — it is the
 * one state whose entire job is to accept something — so it answers false and
 * takes the idle frame, or the hover frame while a drop would land.
 */
export function isSlotDisabled(slot: HotbarSlot): boolean {
  switch (slot.kind) {
    case HotbarSlotKind.Item:
      return slot.action === ItemSlotAction.Gone;
    case HotbarSlotKind.Empty:
      return false;
    case HotbarSlotKind.Talent:
      return slot.cooldown > 0 || !slot.affordable;
  }
}

/**
 * Is the pointer carrying something a hotbar slot could hold?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS WAS TWO PREDICATES AND THE SECOND ONE ARGUED FOR THE PARTITION.
 * ═══════════════════════════════════════════════════════════════════════════
 * `isTalentDrag` was *"the exact twin of `isItemDrag` and deliberately a
 * separate function. One predicate answering 'could this go on the bar
 * somewhere' would light every slot for every drag, and the player would learn
 * that a talent can go on an item slot — which it cannot."*
 *
 * A talent CAN go on any slot now, so the sentence that made them twins is the
 * sentence that merges them: one predicate lights every slot for every drag
 * because every slot takes every drag, and the highlight is telling the truth
 * again rather than in spite of itself.
 *
 * ALL THREE BINDABLE KINDS QUALIFY. A `Worn` drag names a `Slot` rather than an
 * id (drag.ts:358-361), so the caller resolves it to an item before binding —
 * but the SLOT still has to light up while the pointer is over it, or the
 * player learns that dragging off the doll is not allowed, which is not true.
 *
 * A `Panel` or `Resize` drag never does: both belong to a panel clamped into
 * `panelBand`, which stops above the hotbar, so neither can come to rest over a
 * slot in the first place (drag.ts:165-180).
 */
function isBindableDrag(drag: DragSubject | null | undefined): boolean {
  if (drag === undefined || drag === null) return false;
  switch (drag.kind) {
    case DragKind.Carried:
    case DragKind.Worn:
    case DragKind.Talent:
      return true;
    case DragKind.Resize:
    case DragKind.Panel:
      return false;
  }
}

/**
 * Which frame art a slot wears.
 *
 * Disabled outranks hover and armed: a slot you cannot press must not light up
 * when the pointer crosses it, because a lit button that does nothing is worse
 * than a dead one that looks dead. GONE is the item-slot spelling of that, and
 * upstream greys a dangling binding for the same reason
 * (HotkeysIconsDisplay.lua:203-206).
 *
 * AN EMPTY SLOT LIGHTS ON THE DRAG, NOT ON THE HOVER, and the asymmetry is the
 * rule above applied honestly: hovering an empty slot with an empty hand does
 * nothing, so it must not look pressable; hovering it with an item in hand is a
 * drop that will land, so it must.
 */
function frameIdFor(
  slot: HotbarSlot,
  hovered: boolean,
  armed: boolean,
  dragging: boolean,
): FrameState {
  switch (slot.kind) {
    case HotbarSlotKind.Empty:
      return dragging ? FrameState.Hover : FrameState.Idle;
    case HotbarSlotKind.Item:
      if (isSlotDisabled(slot)) return FrameState.Disabled;
      return hovered ? FrameState.Hover : FrameState.Idle;
    case HotbarSlotKind.Talent:
      if (isSlotDisabled(slot)) return FrameState.Disabled;
      return hovered || armed ? FrameState.Hover : FrameState.Idle;
  }
}

/**
 * The word an item slot wears under its icon, per state. The KEY is drawn
 * top-left by `paintSlot` on every kind; this is the second, worded signal,
 * which is why the two never competed for the same corner.
 */
function captionForAction(action: ItemSlotAction): string {
  switch (action) {
    case ItemSlotAction.Equip:
      return 'EQUIP';
    case ItemSlotAction.Use:
      return 'USE';
    case ItemSlotAction.Unequip:
      return 'REMOVE';
    case ItemSlotAction.Gone:
      return 'GONE';
  }
}

/** ORANGE for the state that cannot be acted on — the same pairing the cost readout uses. */
function captionColourForAction(action: ItemSlotAction): string {
  return action === ItemSlotAction.Gone ? PALETTE.ORANGE : PALETTE.PARCHMENT;
}

// ---------------------------------------------------------------------------
// PRIMITIVES
// ---------------------------------------------------------------------------

/** Trim to fit, with an ellipsis. Talent and item names are authored, but not by this file. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxPx: number): string {
  if (maxPx <= 0) return '';
  if (ctx.measureText(text).width <= maxPx) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxPx) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * The icon, or initials.
 *
 * ═══ THE FALLBACK IS THE ONLY PATH A BARE CLONE EVER TAKES ═══
 * client/public/assets/ is gitignored in its entirety, so on a fresh checkout
 * `sprites.sprite()` resolves nothing and EIGHT identical violet error boxes
 * would make the bar unusable. Two letters keep the buttons distinguishable,
 * which is all this has to be. Upstream does the same thing with a literal '?'
 * (HotkeysIconsDisplay.lua:68, `default_entity`).
 *
 * ON A MACHINE THAT HAS THE ART this is now the live path for talents, and that
 * is recent: `icon_active_*` is what every talent in src/server/talents/
 * declares, and the loader filtered on a dead `icon_ability_` prefix for weeks
 * after the twelve icons landed. The prefix is fixed (main.ts's
 * `NEEDED_ASSET_PREFIXES`, pinned by test/client/assets.test.ts:231-249) and
 * `item_` is on the same list, so both halves of the bar resolve.
 */
function drawIconArt(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  iconId: string,
  name: string,
  x: number,
  y: number,
): void {
  const sprite = sprites.sprite(iconId);
  if (sprite !== undefined) {
    // DRAWN AT `ICON_DRAW_PX`, NOT AT THE SPRITE'S OWN SIZE. Every hotbar icon
    // is authored at 64 and this is exactly half — see `ICON_PX`. Smoothing is
    // already off for the whole backbuffer, so a 2:1 reduction takes every
    // other pixel and stays sharp; it is the one ratio this may use.
    ctx.drawImage(sprite.image, x, y, ICON_DRAW_PX, ICON_DRAW_PX);
    return;
  }

  ctx.fillStyle = PALETTE.VOID;
  ctx.fillRect(x, y, ICON_DRAW_PX, ICON_DRAW_PX);
  ctx.fillStyle = PALETTE.SILVER;
  ctx.font = FONT_WIPE;
  ctx.textAlign = 'center';
  const initials = name
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase())
    .join('')
    .slice(0, 2);
  ctx.fillText(initials, x + ICON_DRAW_PX / 2, y + ICON_DRAW_PX / 2);
  ctx.textAlign = 'left';
}

/**
 * The empty-slot plate: `ui_inventory_cell_empty`, centred in the icon well.
 *
 * THE SAME 40x40 PLATE THE PAPERDOLL USES (ui/inventory.ts blits it into an
 * empty doll cell), and that is the point — an empty box on the doll and an
 * empty box on the bar mean the same thing to the player, so they look the same.
 * No new id: the manifest holds exactly two `ui_inventory_cell_*` and both are
 * already loaded.
 *
 * NEVER SCALED. A plate that does not fit its well is a pipeline fault, and
 * drawing a stretched one would hide that fault behind something that looks
 * almost right — ui/inventory.ts's `blitCentred` refuses for the same reason.
 * The traced square below is the refusal AND the bare-clone path.
 */
function drawEmptyPlate(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  x: number,
  y: number,
): void {
  /**
   * THE 40-PIXEL PLATE NO LONGER FITS, so it is not drawn.
   *
   * `ui_inventory_cell_empty` is 40x40 and the icon well is now 32. The rule
   * this function has always followed is NEVER SCALED — "a plate that does not
   * fit its well is a pipeline fault, and drawing a stretched one would hide
   * that fault behind something that looks almost right". 40 into 32 is 4:5,
   * which is precisely the fractional resample that rule exists to refuse, so
   * the honest answer is the traced square: it was already the refusal path and
   * the bare-clone path, and it reads correctly at any size.
   *
   * The paperdoll still blits the real plate — its wells are 40 and always were.
   */
  const px = x;
  const py = y;
  ctx.fillStyle = PALETTE.GREY;
  ctx.fillRect(px, py, ICON_DRAW_PX, 1);
  ctx.fillRect(px, py + ICON_DRAW_PX - 1, ICON_DRAW_PX, 1);
  ctx.fillRect(px, py, 1, ICON_DRAW_PX);
  ctx.fillRect(px + ICON_DRAW_PX - 1, py, 1, ICON_DRAW_PX);
}

/**
 * A word across the bottom of a slot, outlined so it survives whatever the icon
 * puts behind it.
 *
 * The outline is the trick the cooldown digits use, and for the same reason: the
 * caption sits over the bottom four pixels of a 64px icon nobody in this file
 * authored, so its background is unknowable.
 */
function drawCaption(
  ctx: CanvasRenderingContext2D,
  rect: SlotRect,
  text: string,
  fill: string,
): void {
  ctx.save();
  ctx.font = FONT_CAPTION;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cx = rect.x + Math.floor(rect.w / 2);
  const cy = rect.y + rect.h - CAPTION_BASELINE;
  ctx.lineWidth = 3;
  ctx.strokeStyle = PALETTE.INK;
  ctx.strokeText(text, cx, cy);
  ctx.fillStyle = fill;
  ctx.fillText(text, cx, cy);
  ctx.restore();
}

/**
 * THE WIPE. A clockwise wedge from twelve o'clock covering `remaining / total`
 * of the icon, then the number.
 *
 * CLIPPED to the icon square, which is why `WIPE_RADIUS` may exceed the icon's
 * half-width: the wedge has to reach the corners of a square, so it is drawn on
 * a circle big enough to cover them and cut back to the box. Without the clip the
 * wedge spills over the frame art and the slot loses its border on three sides
 * out of four, depending on the fraction.
 *
 * `total <= 0` cannot normally happen (a talent with no cooldown never appears
 * in the `cooldowns` frame) but is treated as a FULL wipe rather than a division
 * by zero, so a content bug reads as "this talent is unavailable" instead of
 * painting NaN.
 */
function drawCooldownWipe(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  remaining: number,
  total: number,
): void {
  const fraction = total > 0 ? Math.min(1, Math.max(0, remaining / total)) : 1;
  const cx = x + ICON_DRAW_PX / 2;
  const cy = y + ICON_DRAW_PX / 2;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, ICON_DRAW_PX, ICON_DRAW_PX);
  ctx.clip();

  ctx.globalAlpha = WIPE_ALPHA;
  ctx.fillStyle = PALETTE.INK;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  // -PI/2 is twelve o'clock; sweeping positive is clockwise on a canvas, whose
  // y axis points down.
  ctx.arc(cx, cy, WIPE_RADIUS, -Math.PI / 2, -Math.PI / 2 + fraction * Math.PI * 2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // The digits, over the wedge. Outlined so they stay legible against both the
  // darkened half of the icon and the undarkened half.
  const digits = `${Math.ceil(remaining)}`;
  ctx.save();
  ctx.font = FONT_WIPE;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.strokeStyle = PALETTE.INK;
  ctx.strokeText(digits, cx, cy);
  ctx.fillStyle = PALETTE.GOLD;
  ctx.fillText(digits, cx, cy);
  ctx.restore();
}

/** The frame, or a traced box, so a missing PNG never removes the button. */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FRAME: ONE NINE-SLICE SKIN, THEN THE STATE DRAWN OVER IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It used to blit one of three 72x72 PNGs — idle, hover, disabled — which is
 * what pinned `SLOT_PX` at 72 and made the bar eighteen per cent of the screen.
 *
 * Now the WELL is `ui_panel_9slice_inset`, the same skin the Case Log wears,
 * drawn at whatever size the slot is; and the STATE is drawn on top as a border
 * and, when refused, a hatch. That is a better division than three baked
 * pictures anyway: the state is a one-pixel edge that can be tuned without
 * re-cutting art, and the three sizes can never drift apart.
 *
 * ═══ THE HATCH IS NOW DRAWN, AND IT HAS TO BE ═══
 * `ui_hotbar_slot_disabled` carried a diagonal hatch across the frame, and that
 * hatch is the only channel that says "you cannot press this" without relying
 * on colour — which matters here for the same reason it does on the world map's
 * danger grades. It is reproduced in code rather than dropped.
 *
 * NO NEW SPRITE ID IS INVENTED. `ui_panel_9slice_inset` is already in the
 * manifest and already loaded; the three `ui_hotbar_slot_*` ids simply stop
 * being asked for, which costs nothing at runtime.
 */
function drawFrame(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  state: FrameState,
  rect: SlotRect,
  /** Is this a stance that is currently UP? See the ring below. */
  sustained = false,
): void {
  drawPanel(ctx, sprites, PanelSkin.Inset, rect);

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE STANCE IS UP — HotkeysIconsDisplay.lua:120-125, :184-186.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ═══ WITHOUT IT, A TOGGLE'S TWO OPPOSITE MEANINGS LOOK IDENTICAL ═══
   * `LoadoutTalent.sustained` has been on the wire since stances existed and
   * says exactly why: *"a sustain is the one talent whose state a player must
   * READ before pressing … without this the same key would sometimes put a
   * stance up and sometimes take it down, with nothing on screen to say which
   * was about to happen."* The server has been sending it and
   * `grep -rn sustained src/client/` returned NOTHING — a stance that was up was
   * pixel-identical to one that was down, on the bar and everywhere else.
   *
   * ═══ NOT A FOURTH `FrameState`, AND THAT IS THE DESIGN ═══
   * The three states are mutually exclusive answers to "can I press this"; being
   * up is a different question entirely, and a stance can be up AND hovered AND
   * on cooldown at once. Folding it into that enum would make hovering a raised
   * stance hide the fact that it is raised — which is the exact moment the
   * player is about to press it.
   *
   * ═══ A RING, WHICH IS A SHAPE AND NOT ONLY A COLOUR ═══
   * An inset outline the other three states do not draw, so the difference
   * survives at a glance and for the roughly one man in twelve who cannot
   * separate the violet from the slate — the same rule ui/resource.ts applies to
   * the pips and ui/partypanel.ts to the turn chips. VIOLET_HI because a raised stance
   * is a thing the player did on purpose, and gold is already spoken for by
   * hover.
   */
  if (sustained) {
    ctx.save();
    ctx.fillStyle = PALETTE.VIOLET_HI;
    const x = rect.x + 2;
    const y = rect.y + 2;
    const w = rect.w - 4;
    const h = rect.h - 4;
    ctx.fillRect(x, y, w, 1);
    ctx.fillRect(x, y + h - 1, w, 1);
    ctx.fillRect(x, y, 1, h);
    ctx.fillRect(x + w - 1, y, 1, h);
    ctx.restore();
  }

  if (state === FrameState.Disabled) {
    // THE HATCH, corner to corner, clipped to the well. Spaced at 6 so it reads
    // as "struck through" rather than as a texture.
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x + 2, rect.y + 2, rect.w - 4, rect.h - 4);
    ctx.clip();
    ctx.strokeStyle = 'rgba(12, 10, 20, 0.55)';
    ctx.lineWidth = 1;
    for (let i = -rect.h; i < rect.w; i += 6) {
      ctx.beginPath();
      ctx.moveTo(rect.x + i + 0.5, rect.y + rect.h);
      ctx.lineTo(rect.x + i + rect.h + 0.5, rect.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // THE EDGE LAST, so neither the well's own border nor the hatch sits over it.
  // Hover is the only state that brightens: an armed slot is already saying so
  // with its caption and its icon, and two loud signals for one fact reads as a
  // bug rather than as emphasis.
  if (state === FrameState.Hover) {
    ctx.fillStyle = PALETTE.GOLD;
    ctx.fillRect(rect.x, rect.y, rect.w, 1);
    ctx.fillRect(rect.x, rect.y + rect.h - 1, rect.w, 1);
    ctx.fillRect(rect.x, rect.y, 1, rect.h);
    ctx.fillRect(rect.x + rect.w - 1, rect.y, 1, rect.h);
  }
}

/**
 * ONE SLOT, whole: the frame, then whatever its kind puts inside it, then the
 * word.
 *
 * Exhaustive over `HotbarSlot`. `@typescript-eslint/switch-exhaustiveness-check`
 * runs with `allowDefaultCaseForExhaustiveSwitch: false`, so a fourth kind
 * cannot be added without this switch — and `frameIdFor` and `isSlotDisabled` —
 * failing to compile. That is the mechanism that stops a new state shipping as a
 * blank box.
 */
function paintSlot(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  slot: HotbarSlot,
  index: number,
  rect: SlotRect,
  hovered: boolean,
  armed: boolean,
  dragging: boolean,
): void {
  drawFrame(
    ctx,
    sprites,
    frameIdFor(slot, hovered, armed, dragging),
    rect,
    // `=== true` RATHER THAN TRUTHINESS: the field is optional and absent on
    // everything that is not a sustain, which must read as "not up" and never as
    // a claim that an active could be sustained.
    slot.kind === HotbarSlotKind.Talent && slot.talent.sustained === true,
  );

  const iconX = rect.x + ICON_INSET;
  const iconY = rect.y + ICON_INSET;

  switch (slot.kind) {
    case HotbarSlotKind.Empty: {
      drawEmptyPlate(ctx, sprites, iconX, iconY);
      // BIND while a drop would land, EMPTY otherwise. The caption is what makes
      // this a SLOT rather than a gap in the row, and on a bare clone it is the
      // only thing here at all.
      //
      // IT READ `ITEM` AND THAT WAS THE PARTITION TALKING. An empty slot took
      // an item and nothing else, so naming the one kind it accepted was a
      // useful instruction; it now accepts either kind, so the same word would
      // send a player who wanted a talent on it to the wrong panel.
      drawCaption(ctx, rect, dragging ? 'BIND' : 'EMPTY', PALETTE.GREY_HI);
      break;
    }

    case HotbarSlotKind.Item: {
      drawIconArt(ctx, sprites, slot.icon, slot.name, iconX, iconY);
      drawCaption(ctx, rect, captionForAction(slot.action), captionColourForAction(slot.action));
      break;
    }

    case HotbarSlotKind.Talent: {
      drawIconArt(ctx, sprites, slot.talent.icon, slot.talent.name, iconX, iconY);

      if (slot.cooldown > 0) {
        drawCooldownWipe(ctx, iconX, iconY, slot.cooldown, slot.talent.cooldownTurns);
      }

      // THE ARMED RING. A gold border around the slot whose targeting mode is
      // open, so "which button am I aiming?" is answerable without reading the
      // hint line. Two pixels, drawn over the frame art rather than replacing it.
      if (armed) {
        ctx.fillStyle = PALETTE.GOLD;
        ctx.fillRect(rect.x, rect.y, rect.w, 2);
        ctx.fillRect(rect.x, rect.y + rect.h - 2, rect.w, 2);
        ctx.fillRect(rect.x, rect.y, 2, rect.h);
        ctx.fillRect(rect.x + rect.w - 2, rect.y, 2, rect.h);
      }

      // The cost, bottom-right, in ORANGE when it cannot be paid — a second,
      // worded signal beside the hatched frame, for the same reason the turn chips
      // carry names.
      //
      // AP IS THE NUMBER SHOWN, and the class resource only when the talent
      // spends no AP. game-design.md § 2 writes every talent as "AP 5" or
      // "AP 4, MP 1", so AP is the cost a player has learned to look for; the
      // resource pips under the row already answer "can I afford the reagent".
      // Two numbers in a 32-pixel corner is unreadable at any font size.
      const shown = slot.talent.cost.ap > 0 ? slot.talent.cost.ap : slot.talent.cost.resource;
      if (shown > 0) {
        ctx.font = FONT_COST;
        ctx.textAlign = 'right';
        ctx.fillStyle = slot.affordable ? PALETTE.BONE : PALETTE.ORANGE;
        ctx.fillText(`${shown}`, rect.x + rect.w - 5, rect.y + rect.h - 8);
        ctx.textAlign = 'left';
      }
      break;
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE KEY, TOP-LEFT, ON EVERY SLOT — AND IT USED TO BE INSIDE THE TALENT ARM.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This is the label that actually gets used: nobody clicks a hotbar in a
   * keyboard game, they press 2.
   *
   * IT WAS GUARDED ON THE INDEX AND THE GUARD WAS RIGHT — *"a talent that
   * somehow landed at index 5 would otherwise wear a '6' that no key sends. A
   * slot with no digit is honest; a slot advertising a key that walks you north
   * is not."* It still is, and `hotbarKeyLabel` IS that guard: it answers null
   * past the pool, and the press resolves the same mapping back through
   * `hotbarSlotForKey`, so a printed key that sends nothing cannot exist.
   *
   * WHAT CHANGED IS THE KIND, NOT THE GUARD. The label was drawn only for a
   * talent because only a talent slot had a key; an item on slot 3 now presses
   * on `3` exactly as a talent does, and a bar where four of thirteen buttons
   * silently have no key is the segregation the split was reported for.
   */
  const key = hotbarKeyLabel(index);
  if (key !== null) {
    ctx.font = FONT_KEY;
    ctx.fillStyle = PALETTE.PARCHMENT;
    ctx.textAlign = 'left';
    ctx.fillText(key, rect.x + 5, rect.y + 8);
  }
}

/**
 * The one line under the row, or null when there is nothing to say.
 *
 * A permanently occupied line of prose becomes furniture and stops being read,
 * so it stays empty most of the time — but a REFUSAL always outranks a name.
 * When the row did not fit, that sentence is the only place the player can learn
 * why there are four boxes instead of eight, and silence there is precisely the
 * failure the old `continue` shipped.
 */
type StripLine = { readonly text: string; readonly colour: string };

/**
 * The sentence a bound item slot puts under the row.
 *
 * Its own function rather than a nested `switch`, so both switches stay flat and
 * exhaustive — a nested one would need a fallthrough to reach the talent case,
 * and `noFallthroughCasesInSwitch` is on for exactly the reason that would be a
 * bad idea.
 */
/**
 * EXPORTED FOR THE SAME REASON `itemSlotAction` IS. This and `itemActionWord`
 * are two sentences about one press, read by the same player half a second
 * apart — the strip under the bar and the hover card — and two verbs for one
 * button is how a control stops being trusted. Only one of them was reachable
 * from a test, so a mutation that made the strip say "equip" over a draught
 * passed while the card said "use".
 */
export function itemStrip(name: string, action: ItemSlotAction): StripLine {
  switch (action) {
    case ItemSlotAction.Equip:
      return { text: `${name} — click to equip`, colour: PALETTE.GOLD };
    case ItemSlotAction.Use:
      return { text: `${name} — click to use`, colour: PALETTE.GOLD };
    case ItemSlotAction.Unequip:
      return { text: `${name} — click to remove`, colour: PALETTE.GOLD };
    case ItemSlotAction.Gone:
      // Upstream's own words for the dangling binding, PlayerHotkeys.lua:177:
      // "You do not have any <name>."
      return { text: `${name} — you no longer have it`, colour: PALETTE.ORANGE };
  }
}

/**
 * What the header says when the pointer is on nothing: how many bound slots the
 * bar is currently too small to draw, or nothing at all.
 *
 * ═══ THE HOVER OUTRANKS IT, AND THAT IS THE WHOLE PLACEMENT ARGUMENT ═══
 * The strip has one line. A permanent count would take it away from the name of
 * the talent under the pointer, which is the thing a player is reading the
 * strip FOR. So this is the idle state of the same line: it is on screen
 * exactly when the strip would otherwise be blank, it costs no pixels, and it
 * is gone the moment the pointer wants the row for something else.
 *
 * `HotbarView.hidden` carries the argument for the number itself.
 *
 * ═══ THE ORDER OF THE WORDS IS LOAD-BEARING, AND IT WAS MEASURED ═══
 * The strip is cut to the header's width by `fitText`, and the header of a
 * FIVE-slot bar is about thirty-six characters of the 10px monospace this
 * draws in. The first version of this line read *"3 past the end of the bar —
 * still bound, widen it to reach them"* and came out as *"3 past the end of the
 * bar — still b…"* on exactly the bar somebody has just shrunk — which is to
 * say it lost the clause it exists for and kept the one a player could already
 * see. `still bound` therefore comes THIRD WORD, so the sentence degrades from
 * the far end and the fact survives every width the bar has.
 */
function offBarLine(view: HotbarView): StripLine | null {
  const hidden = view.hidden ?? 0;
  if (hidden <= 0) return null;
  return {
    text: `${String(hidden)} still bound past the end — widen the bar`,
    colour: PALETTE.GREY_HI,
  };
}

function stripFor(view: HotbarView, count: number): StripLine | null {
  const focused = view.armed >= 0 ? view.armed : view.hovered;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE PAGE LINE IS GONE, WITH THE PAGE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This opened with `page 2 (hold Shift)` in VIOLET_HI, outranking the name
   * under the pointer, because *"the six buttons a player has spent the whole
   * game learning have just been replaced, and the one thing they need to know
   * is that it was on purpose."* That sentence was the cost of a bar whose
   * picture changed under the player's hand. It does not change any more —
   * Shift reaches the second nine slots rather than replacing the first nine —
   * so the warning has nothing left to warn about, and a permanently-possible
   * line of prose that can never be true is furniture.
   */
  if (focused < 0 || focused >= count) return offBarLine(view);
  const slot = view.slots[focused];
  if (slot === undefined) return offBarLine(view);
  const key = hotbarKeyLabel(focused);
  /** `3. ` or `⇧3. `, and nothing at all past the pool. One label, both readers. */
  const lead = key === null ? '' : `${key}. `;

  switch (slot.kind) {
    case HotbarSlotKind.Empty:
      // ONE SENTENCE, BECAUSE THERE IS ONE KIND OF SLOT. It used to pick a noun
      // off `isItemSlotIndex` — *"'drag an item here' over a keyed slot is a
      // sentence that sends the player to the wrong panel"* — and naming only
      // one of the two kinds an empty slot now takes would be that same bug
      // with the halves swapped.
      return {
        text: `${lead}empty — drag a talent or an item here`,
        colour: PALETTE.GREY_HI,
      };
    case HotbarSlotKind.Item:
      return itemStrip(slot.name, slot.action);
    case HotbarSlotKind.Talent:
      return { text: `${lead}${slot.talent.name}`, colour: PALETTE.GOLD };
  }
}

/**
 * Paint the bar.
 *
 * Wrapped in save/restore because it changes `font`, `textAlign`,
 * `textBaseline`, `globalAlpha`, `lineWidth` and the clip — none of which the
 * world painter re-sets before every call, so a leak would show up three
 * milestones from now as a mysteriously translucent sprite.
 */
export function drawHotbar(options: HotbarOptions): void {
  const { ctx, sprites, view, rect } = options;
  const style = options.style ?? DEFAULT_HOTBAR_STYLE;
  const count = view.slots.length;
  if (count === 0) return;

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ONE FLAG FOR THE WHOLE BAR AGAIN, AND THIS TIME IT IS THE HONEST ONE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * It was one flag (`isItemDrag`), then two resolved per slot: *"a single flag
   * would light an empty TALENT slot while the player carries an ITEM,
   * promising a drop that `hotbarDropTargetAt` will refuse in words."*
   *
   * There is no refusal left to promise. Every slot takes every bindable kind,
   * so the per-slot resolution would now compute the same answer for all of
   * them — and a `landsOn(index)` that ignores its argument is a control
   * pretending to have a rule. `frameIdFor` reads it only in its `Empty` arm,
   * which is where a drop actually changes the picture.
   */
  const dragLands = isBindableDrag(view.drag);

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  // ITS OWN PANEL, in the case log's skin. It was a backing strip the width of
  // the screen with the slots centred in it, which left bare wings at the sides.
  //
  // THE FADE IS ON THE FRAME AND NEVER ON THE SLOTS, the case log's rule: a bar
  // a player can see the map through is one whose buttons they can still read.
  ctx.globalAlpha = style.opacity / 100;
  drawPanel(ctx, sprites, PanelSkin.Inset, rect);
  ctx.globalAlpha = 1;

  const scale = scaleOf(style);
  for (let i = 0; i < count; i += 1) {
    const slot = view.slots[i];
    if (slot === undefined) continue;
    const at = slotRect(rect, i, count, style);
    if (scale === 1) {
      paintSlot(ctx, sprites, slot, i, at, view.hovered === i, view.armed === i, dragLands);
      continue;
    }
    // A BIGGER ICON IS THE SAME SLOT DRAWN BIGGER, so every frame, caption and
    // wipe keeps the proportions its painter was written for.
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.scale(scale, scale);
    const unit = { x: 0, y: 0, w: SLOT_PX, h: SLOT_PX };
    paintSlot(ctx, sprites, slot, i, unit, view.hovered === i, view.armed === i, dragLands);
    ctx.restore();
  }

  // WHAT THE POINTER IS ON, in the header. Cut to the header's width: a narrow
  // bar is one its player chose, and the hover card says the whole sentence.
  const strip = stripFor(view, count);
  if (strip !== null) {
    const head = hotbarHeaderRect(rect);
    ctx.font = FONT_NAME;
    ctx.fillStyle = strip.colour;
    const room = Math.max(0, head.w - HOTBAR_COG_PX - 4);
    ctx.fillText(fitText(ctx, strip.text, room), head.x, head.y + Math.floor(head.h / 2));
  }

  ctx.restore();
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A HOTBAR SLOT IS, AS A CARD. Asked for by name.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The bar is eight 32-pixel squares and a digit. Everything else about a slot —
 * what the talent does, what it costs, why it is greyed, what the item in slot 6
 * even is — was only ever discoverable by pressing it and finding out. That is a
 * poor deal in a turn-based game where a press costs the turn.
 *
 * IT REUSES `hotbarSlotAt`, so the card names exactly the slot a press would hit.
 * A second walk of the same rects is a second chance to disagree about which
 * square the pointer is in, which is the failure `slotRect`'s own note is about.
 *
 * ═══ WHY A COOLING TALENT STILL GETS A CARD ═══
 * A greyed slot is the one a player most wants explained: the question is "why
 * can I not press this", and the answer is the meta line. Refusing to draw a card
 * for it would withhold the information exactly when it is wanted.
 */
export function hotbarTipAt(
  view: HotbarView,
  rect: PanelRect | null,
  px: number,
  py: number,
  style: HotbarStyle = DEFAULT_HOTBAR_STYLE,
): HoverCard | null {
  const index = hotbarSlotAt(rect, px, py, view.slots.length, style);
  if (index < 0) return null;
  const slot = view.slots[index];
  if (slot === undefined) return null;

  if (slot.kind === HotbarSlotKind.Talent) {
    const talent = slot.talent;
    const passive = talent.kind === 'passive';
    const meta = passive
      ? 'always on'
      : [
          /**
           * ═══════════════════════════════════════════════════════════════════
           * WHAT THIS KEY IS ABOUT TO DO, FIRST, because on a stance it is the
           * only thing on the card that changes between two presses.
           * ═══════════════════════════════════════════════════════════════════
           *
           * The RING on the frame says a stance is up at a glance; this says
           * which direction pressing takes it, in words. Both are needed and
           * neither replaces the other — the ring is readable without stopping,
           * and the sentence is what a player checks when they have stopped.
           *
           * THREE-VALUED ON PURPOSE, and the wire type is built for it:
           * `sustained` is present ONLY on a sustained talent, so `true` is up,
           * `false` is a stance that is down, and `undefined` is a talent that
           * is not a stance at all and gets no word. `false` on an active would
           * be a claim that it could be sustained.
           */
          talent.sustained === true
            ? 'UP — press to drop'
            : talent.sustained === false
              ? 'press to raise'
              : null,
          slot.cooldown > 0 ? `cooling — ${String(slot.cooldown)}t` : null,
          // TWO DIFFERENT FACTS, and "not affordable" is the wrong sentence for
          // the second: a player short on the pool waits a turn, and a player who
          // has not learned the talent spends a point. Telling them the first
          // when it is the second sends them to wait for something that will
          // never arrive.
          slot.talent.level < 1 ? 'not learned yet' : slot.affordable ? null : 'not affordable',
        ]
          .filter((part) => part !== null)
          .join('  ·  ');
    /**
     * ═══ AND WHAT MAKES IT BIGGER, WHICH THIS CARD COULD NOT SAY ═══
     *
     * The talents panel is a screen a player opens on level-up; THIS is what
     * they read mid-fight, and it carried the description alone. `scales`
     * arrives on the same wire object as everything else here and was simply
     * not read.
     *
     * IN `lines`, NOT IN `meta`, and both halves of that matter. `meta` is
     * built only on the non-passive arm — a passive gets the literal string
     * `always on` and never reaches the cost clause — so a meta insertion
     * would omit the scaling from exactly the talents whose only interesting
     * fact it is. And `meta` is one line that truncates from the right, where
     * the scaling would be the first thing cut.
     */
    const scales = talent.scales ?? '';
    /**
     * ════════════════════════════════════════════════════════════════════════
     * ONE FACT PER LINE, LABELLED — which is what ToME does and what this card
     * was asked for.
     * ════════════════════════════════════════════════════════════════════════
     * `Actor.lua:6200-6300` (`getTalentFullDescription`) prints `Use mode: `,
     * `<pool> cost: `, `Range: `, `Cooldown: ` — each on its OWN line with its
     * own label, and only then the effect. Ours packed all of it into one
     * `·`-separated strip above a paragraph, which is unreadable at a glance:
     * *"hard to tell what abilities do as they are not properly formatted"*.
     *
     * THE SPLIT IS PRICE vs STATE, and it is why `meta` survives at all. A
     * label/value row is a fact about the TALENT and is true whenever you look
     * at it; `meta` now carries only what is true THIS INSTANT — whether a
     * stance is up, whether it is cooling, whether you can afford it. The one
     * changes on level-up, the other between two presses, and mixing them is
     * how `cooling — 3t` came to sit beside `4 AP` as though both were prices.
     *
     * `Range: melee` RATHER THAN UPSTREAM'S `melee/personal`, because this game
     * has no personal-only talents and the slash would be an option a player
     * cannot take.
     *
     * NO `Travel Speed:` ROW, though upstream prints one unconditionally. See
     * `engine/talents.ts` on `addProjectile`: the only shooter in the game is a
     * monster, so every player talent would read "instantaneous" — a row that
     * is furniture on all of them.
     */
    const useMode = passive
      ? 'Passive'
      : talent.sustained === undefined
        ? 'Activated'
        : 'Sustained';
    /**
     * A PASSIVE GETS ITS MODE AND NOTHING ELSE. It is never pressed, so an
     * `AP cost: 0` and a `Range: melee` off a range field it does not use are
     * both answers to questions nobody asked — and `Range: melee` is worse than
     * noise, because it reads as a claim the talent reaches something.
     */
    const rows = (
      passive
        ? [`Use mode: ${useMode}`]
        : [
            `Use mode: ${useMode}`,
            talent.cost.ap > 0 ? `AP cost: ${String(talent.cost.ap)}` : null,
            talent.cost.resource > 0 && view.pool !== undefined
              ? `${resourceLabel(view.pool)} cost: ${String(talent.cost.resource)}`
              : null,
            `Range: ${talent.range >= 2 ? String(talent.range) : 'melee'}`,
            talent.cooldownTurns > 0 ? `Cooldown: ${String(talent.cooldownTurns)}` : null,
          ]
    ).filter((row) => row !== null);

    return {
      title: `${talent.name}  ${String(talent.level)}/${String(talent.maxLevel)}`,
      meta,
      // A BLANK LINE BETWEEN THE FACTS AND THE SENTENCE. Without it the rows
      // and the prose read as one block and the labelling buys nothing.
      lines: [
        ...rows,
        '',
        ...wrapForCard(talent.desc),
        ...(scales === '' ? [] : ['', ...wrapForCard(`Scales: ${scales}`)]),
      ],
      nextLines: [],
    };
  }

  if (slot.kind === HotbarSlotKind.Item) {
    // AN ITEM SLOT KNOWS ITS NAME AND WHAT PRESSING IT WOULD DO, and nothing
    // else — `HotbarItemSlot` carries no description, by design, because the
    // binding is the only thing remembered between frames. A short card that is
    // true beats a long one that would need the bag's catalogue on the bar.
    /**
     * ═══ IT SAID THE NAME AND THE VERB AND STOPPED ═══
     * `lines: []` meant the bar — which is where a consumable is actually USED —
     * was the one surface that could name a draught without ever saying what it
     * does. The sentence was already on the wire and already rendered against
     * this body's own Constitution; the bag's card next door was reading it.
     *
     * ═══ STATS FIRST, PROSE LAST — AND THIS SAID SO WHILE DOING THE REVERSE ═══
     * The paragraph here read *"the stats come last, under the prose, in the
     * order ... `inventoryTipAt` uses — two cards about one item laid out two
     * ways would read as two different features"*, and then laid them out the
     * other way. `inventoryTipAt` puts STATS FIRST and cites why:
     * `Object.lua:2027-2028` merges `getUseDesc` at the very END of
     * `getTextualDesc`, after the wielder block. That card was corrected; this
     * one kept the old order under a comment claiming it matched.
     *
     * So the two cards agree now, and they agree with upstream. On the only item
     * that has both — the Draught of Mending — a sentence no longer pushes the
     * numbers down the card, on the surface a player reads while deciding
     * whether to drink it.
     */
    // THE SAME COLUMNS THE ITEM CARD USES -- one helper, so a coat hovered on
    // the bar and the same coat hovered in the bag cannot lay out differently.
    const stats = cardStatLines(slot.rows ?? []);
    const prose = slot.desc === undefined || slot.desc === '' ? [] : [slot.desc];
    return {
      title: slot.name,
      meta: itemActionWord(slot.action),
      lines: [...stats, ...prose],
    };
  }

  return null;
}

/** The verb a press on this slot would perform, in the player's words. */
export function itemActionWord(action: ItemSlotAction): string {
  switch (action) {
    case ItemSlotAction.Equip:
      return 'press to put it on';
    case ItemSlotAction.Use:
      return 'press to use it';
    case ItemSlotAction.Unequip:
      return 'worn — press to take it off';
    case ItemSlotAction.Gone:
      // PlayerHotkeys.lua:176-177 is this case upstream and it does not go quiet
      // either. A bound slot whose item is gone is the one a player most needs
      // told about, because the binding still looks live.
      return 'you are not carrying one';
  }
}

/**
 * One wrapping, against the card's own width, through the shared measurer.
 *
 * The card is 240 logical pixels of prose — about forty monospace characters,
 * which is a sentence and a half. Measured with an offscreen context rather than
 * the painter's, so measuring can never clobber the font the painter had set.
 */
let cardMeasurer: CanvasRenderingContext2D | null | undefined;
function wrapForCard(text: string): readonly string[] {
  if (cardMeasurer === undefined) {
    cardMeasurer =
      typeof document === 'undefined'
        ? null
        : (document.createElement('canvas').getContext('2d') ?? null);
  }
  const ctx = cardMeasurer;
  if (ctx === null) return [text];
  ctx.font = '10px ui-monospace, Consolas, monospace';
  return wrapText(ctx, text, 240);
}

// ---------------------------------------------------------------------------
// THE COGWHEEL AND ITS POPOVER
// ---------------------------------------------------------------------------

/** The cogwheel's square. It sits in the header, which is one line of text tall. */
const HOTBAR_COG_PX = 11;

/** The cogwheel, at the right-hand end of the header. */
export function hotbarCogRect(rect: PanelRect): PanelRect {
  const head = hotbarHeaderRect(rect);
  return {
    x: head.x + head.w - HOTBAR_COG_PX,
    y: head.y + Math.floor((head.h - HOTBAR_COG_PX) / 2),
    w: HOTBAR_COG_PX,
    h: HOTBAR_COG_PX,
  };
}

export function hotbarCogAt(rect: PanelRect | null, px: number, py: number): boolean {
  if (rect === null) return false;
  const cog = hotbarCogRect(rect);
  return px >= cog.x && px < cog.x + cog.w && py >= cog.y && py < cog.y + cog.h;
}

/**
 * The popover's rows, in the order a player reads them.
 *
 * SLOTS IS FIRST because it is the one that changes what the bar HOLDS; the
 * other three change how it looks. It was the request that opened this pass —
 * *"i want the cogwheel settings button for the action bar to allow you to add
 * more slots to expand"* — and a player who came here for it should not have to
 * read past two appearance settings to find it.
 */
const SETTING_ROWS = [
  { key: 'slots', label: 'SLOTS' },
  { key: 'vertical', label: 'LAYOUT' },
  { key: 'icon', label: 'SIZE' },
  { key: 'opacity', label: 'FADE' },
] as const;

export type HotbarSettingKey = (typeof SETTING_ROWS)[number]['key'];

const POP_W = 168;
const POP_ROW_H = 16;
const POP_BTN = 14;
const POP_GAP = 3;
const POP_VALUE_W = 64;

function nearestIndex(steps: readonly number[], value: number): number {
  let best = 0;
  steps.forEach((step, i) => {
    if (Math.abs(step - value) < Math.abs((steps[best] ?? step) - value)) best = i;
  });
  return best;
}

function stepOf(steps: readonly number[], value: number, by: -1 | 1): number {
  const next = Math.max(0, Math.min(steps.length - 1, nearestIndex(steps, value) + by));
  return steps[next] ?? value;
}

/** A stored style from another build, on the nearest of this build's steps. */
export function snapHotbarStyle(style: HotbarStyle): HotbarStyle {
  return {
    vertical: style.vertical,
    icon: ICON_STEPS[nearestIndex(ICON_STEPS, style.icon)] ?? ICON_DRAW_PX,
    opacity: FADE_STEPS[nearestIndex(FADE_STEPS, style.opacity)] ?? 100,
    // THE COUNT IS CLAMPED, NOT SNAPPED. It has no steps — every whole number
    // from one to the pool is a bar somebody might want — so what a stored
    // value needs is a bound, and it needs one for the same reason the others
    // need a step: a file written by a build with a bigger pool would otherwise
    // hand this build a count it has no key for.
    slots: Math.max(1, Math.min(HOTBAR_SLOT_POOL, Math.round(style.slots))),
  };
}

/** One press of a `−` or `+`. Each setting stops at its ends; the layout has two. */
export function stepHotbarStyle(
  style: HotbarStyle,
  key: HotbarSettingKey,
  by: -1 | 1,
): HotbarStyle {
  switch (key) {
    case 'vertical':
      return { ...style, vertical: by > 0 };
    case 'icon':
      return { ...style, icon: stepOf(ICON_STEPS, style.icon, by) };
    case 'opacity':
      return { ...style, opacity: stepOf(FADE_STEPS, style.opacity, by) };
    // ONE SLOT A PRESS, and it stops at both ends like every other row here —
    // `drawHotbarSettings` draws a step that changes nothing dead, so the
    // player can see the bar is already as wide as it goes.
    case 'slots':
      return {
        ...style,
        slots: Math.max(1, Math.min(HOTBAR_SLOT_POOL, style.slots + by)),
      };
  }
}

/** What a row reads: `Horizontal`, `Large`, `60%`. */
export function hotbarSettingText(style: HotbarStyle, key: HotbarSettingKey): string {
  switch (key) {
    case 'vertical':
      return style.vertical ? 'Vertical' : 'Horizontal';
    case 'icon':
      return ICON_NAMES[nearestIndex(ICON_STEPS, style.icon)] ?? `${String(style.icon)}px`;
    case 'opacity':
      return `${String(style.opacity)}%`;
    // THE NUMBER ITSELF. A bar of thirteen says `13` — there is no name for it
    // the way `Large` names an icon size, and inventing one ("Wide") would hide
    // the only fact a player pressing `+` is watching.
    case 'slots':
      return `${String(style.slots)}`;
  }
}

/**
 * Where the popover opens: above the bar when there is room under the turn HUD,
 * below it when there is not, and never off the screen.
 */
export function hotbarSettingsRect(
  bar: PanelRect,
  width: number,
  height: number,
  top: number,
): PanelRect {
  const h = SETTING_ROWS.length * POP_ROW_H + PANEL_PAD * 2;
  const x = Math.max(0, Math.min(width - POP_W, bar.x + bar.w - POP_W));
  const above = bar.y - h;
  const y = above >= top ? above : Math.max(top, Math.min(height - h, bar.y + bar.h));
  return { x, y, w: POP_W, h };
}

export type HotbarSettingButton = {
  readonly key: HotbarSettingKey;
  readonly by: -1 | 1;
  readonly rect: PanelRect;
};

/** Every `−` and `+`, row by row: the one copy the painter and the press both read. */
export function hotbarSettingsButtons(pop: PanelRect): HotbarSettingButton[] {
  const out: HotbarSettingButton[] = [];
  const minusX = pop.x + pop.w - PANEL_PAD - POP_BTN * 2 - POP_VALUE_W - POP_GAP * 2;
  const plusX = minusX + POP_BTN + POP_GAP + POP_VALUE_W + POP_GAP;
  SETTING_ROWS.forEach((row, i) => {
    const y = pop.y + PANEL_PAD + i * POP_ROW_H + 1;
    out.push({ key: row.key, by: -1, rect: { x: minusX, y, w: POP_BTN, h: POP_ROW_H - 2 } });
    out.push({ key: row.key, by: 1, rect: { x: plusX, y, w: POP_BTN, h: POP_ROW_H - 2 } });
  });
  return out;
}

/**
 * What a press on the open popover means: a step, its own background (swallowed,
 * so it cannot fall through to the slots under it), or nothing.
 */
export function hotbarSettingsHitAt(
  pop: PanelRect,
  px: number,
  py: number,
): { readonly key: HotbarSettingKey; readonly by: -1 | 1 } | 'inside' | null {
  for (const btn of hotbarSettingsButtons(pop)) {
    const r = btn.rect;
    if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) {
      return { key: btn.key, by: btn.by };
    }
  }
  const inside = px >= pop.x && px < pop.x + pop.w && py >= pop.y && py < pop.y + pop.h;
  return inside ? 'inside' : null;
}

/** The popover, in the case log's popover's skin and grammar. */
export function drawHotbarSettings(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  pop: PanelRect,
  style: HotbarStyle,
): void {
  ctx.save();
  drawPanel(ctx, sprites, PanelSkin.CaseFile, pop);
  ctx.font = FONT_CAPTION;
  ctx.textBaseline = 'middle';
  const buttons = hotbarSettingsButtons(pop);
  SETTING_ROWS.forEach((row, i) => {
    const mid = pop.y + PANEL_PAD + i * POP_ROW_H + POP_ROW_H / 2;
    ctx.textAlign = 'left';
    ctx.fillStyle = PALETTE.GREY_HI;
    ctx.fillText(row.label, pop.x + PANEL_PAD, mid);
    for (const btn of buttons) {
      if (btn.key !== row.key) continue;
      ctx.fillStyle = PALETTE.INK;
      ctx.fillRect(btn.rect.x, btn.rect.y, btn.rect.w, btn.rect.h);
      // A STEP THAT CHANGES NOTHING IS DRAWN DEAD, as the case log's are.
      const dead = stepHotbarStyle(style, btn.key, btn.by)[btn.key] === style[btn.key];
      ctx.fillStyle = dead ? PALETTE.GREY : PALETTE.GOLD;
      ctx.textAlign = 'center';
      ctx.fillText(btn.by < 0 ? '−' : '+', btn.rect.x + btn.rect.w / 2, mid);
      if (btn.by < 0) {
        ctx.fillStyle = PALETTE.PARCHMENT;
        const valueX = btn.rect.x + POP_BTN + POP_GAP + POP_VALUE_W / 2;
        ctx.fillText(hotbarSettingText(style, row.key), valueX, mid);
      }
    }
  });
  ctx.restore();
}
