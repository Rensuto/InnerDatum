/**
 * The hotbar: EIGHT slots — four class talents on keys 1-4, then four ITEM
 * slots that are mouse-only — a 64x64 icon inside a 72x72 frame.
 *
 * ===========================================================================
 * IT USED TO BE FOUR SLOTS AND "THAT IS THE WHOLE UI". IT IS NOT ANY MORE.
 * ===========================================================================
 * The old header argued that the bar "is still the class itself rather than a
 * container the player fills, and there is still deliberately no drag-and-drop,
 * no page 2, no empty-slot state and no binding UI". THAT IS NOW FALSE and is
 * rewritten rather than amended, because a comment that lies is worse than no
 * comment. The player played the deployed build and asked for exactly the thing
 * it refused: "the action bar at the bottom should be slightly smaller and have
 * empty slots so users can drag items out to the bar."
 *
 * WHAT SURVIVED THE CHANGE, because it was right for its own reason and the
 * reason has not moved:
 *
 *   SLOTS 0-3 ARE STILL THE CLASS. A talent point DEEPENS one of the four rather
 *   than adding a fifth, so the talent half of the bar is still fixed, still
 *   arrives in `LoadoutMsg.talents` order, and is still NEVER sorted here:
 *   muscle memory for which key is Ward Rush is worth more than any ordering a
 *   renderer could impose, and a hotbar that re-sorted by cooldown would move
 *   the buttons around mid-fight.
 *
 *   KEYS 1-4 ARE UNCHANGED, and slots 4-7 have NO KEY AT ALL. That is a decision
 *   with a hard reason, not an omission — see the note on `HOTBAR_ITEM_SLOTS`.
 *
 * PORTED, WITH CITATIONS. Upstream's bar holds two kinds of thing in one row of
 * identical boxes: HotkeysIconsDisplay.lua:159-162 tags each occupied slot
 * `"talent"` or `"inventory"` off the same `a.hotkey[j]` table, and :349 accepts
 * a drop of either kind onto any slot. Everything below that is per-kind
 * drawing, which is exactly the shape this file now has.
 *
 * ===========================================================================
 * WHAT AN ITEM ON THE BAR DOES: IT EQUIPS. THERE IS NO USE-ITEM VERB.
 * ===========================================================================
 * The complete client→server vocabulary is hello, move, commit, hold, talent,
 * ping, say, point, revive, respawn, choose_class, spend_point, pickup, equip,
 * unequip, drop, party, inspect, set_keybinds. There is no `use`, no `activate`,
 * no `consume` — and nothing to invoke one on: `Wielder` is `{stats?, mods?}`
 * only (server/content/items.ts:231-234), so all 22 authored items are passive.
 * Shipping a `use` intent for this bar would ship a verb with nothing behind it,
 * which is the "control that does nothing" trap wearing a protocol change.
 *
 * So a bound item slot is a QUICK-SWAP and its verb is equip/unequip:
 *
 *   in `carried`   → caption EQUIP,  click sends `equip {itemId}`
 *   in `equipped`  → caption REMOVE, click sends `unequip {slot}`
 *   in neither     → caption GONE,   click clears the binding and says so
 *
 * The flip between the first two is computed, never remembered — see
 * `itemSlotAction`. Upstream agrees a wearable is not a "use": Object.lua:169-173
 * answers "This object has no usable power." for anything with no activatable,
 * and HotkeysIconsDisplay.lua:232-234 draws a bound object that is currently
 * `o.wielded` in a DIFFERENT frame from one sitting in the pack, which is the
 * same two-state distinction EQUIP/REMOVE draws. DEVIATION, LABELLED: upstream's
 * inventory hotkey routes to `playerUseItem` (PlayerHotkeys.lua:173-181); ours
 * routes to equip/unequip, because we have no usable objects to route to.
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

import { wrapText } from './panel.ts';
import type { HoverCard } from './panel.ts';
import { TALENTS_PER_CLASS_MAX } from '../../shared/progression.ts';
import { PALETTE } from '../render/canvas.ts';
import { SLOT_ORDER } from '../../shared/protocol.ts';
import { DragKind } from './drag.ts';
import { PanelSkin, drawPanel } from './panel.ts';
import type { DragSubject } from './drag.ts';
import type { LoadoutTalent, Slot } from '../../shared/protocol.ts';
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
 * Breathing room above and below the row, inside the backing strip.
 *
 * WAS 4, NOW 2 — half of the six logical pixels the player asked for back
 * ("the action bar at the bottom should be slightly smaller"). It is padding and
 * nothing measures against it, so it is free in a way `SLOT_PX` is not.
 */
const SLOT_PAD = 2;
/**
 * How far the icon sits inside the frame. `(44 - 32) / 2` — stated as the
 * arithmetic so it follows the two constants rather than being a third number
 * that has to be kept in step with them.
 */
const ICON_INSET = Math.floor((SLOT_PX - ICON_DRAW_PX) / 2);

/**
 * Vertical bite the hotbar's BUTTON ROW takes out of the bottom of the viewport.
 *
 * It OVERLAYS the world rather than shrinking the camera, the same way the party
 * strip overlays the top. The cost is real — 76 of 480 logical pixels, about two
 * and a half tile rows — and it is accepted rather than worked around, because
 * the alternative is drawing 72x72 art at some fractional scale, which is
 * precisely the resampling the whole backbuffer exists to prevent. The camera
 * centres on the player, so the tile that matters most is never underneath it.
 */
export const HOTBAR_H = SLOT_PX + SLOT_PAD * 2;

/**
 * The one-line strip under the row.
 *
 * It carries the hovered or armed slot's caption — and, when the row does not
 * fit the viewport, the REFUSAL sentence that says so. WAS 14, NOW 12: a 10px
 * glyph needs twelve, and the other two were the second half of the shrink.
 */
export const HOTBAR_LABEL_H = 12;

/**
 * Everything the hotbar occupies, so main.ts can stack the resource pips and the
 * notice line above it without either guessing the other's height. Exported for
 * exactly that: two files agreeing on a layout by arithmetic rather than by two
 * hard-coded numbers that drift the first time a slot changes size.
 *
 * DERIVED, NEVER TYPED OUT. `panelBand` (main.ts:534-541) subtracts this from the
 * viewport height, so the six pixels the shrink returned reach all four
 * draggable panels with no edit anywhere else — and would reach them wrongly if
 * anybody wrote 88 down a second time.
 */
export const HOTBAR_TOTAL_H = HOTBAR_H + HOTBAR_LABEL_H;

/**
 * Slots 0-3: the class talents, on keys 1-4.
 *
 * ═══ IT IS THE WIDTH THAT CHOOSES THIS, NOT THE CLASS ═══
 * This note used to read *"the count is not this file's to choose — it is
 * `LoadoutMsg.talents.length`, four per class by PLAN.md's MVP cap."* That was
 * true of a bar that drew `loadout[n]` and it is not true of one drawn from
 * BINDINGS: a slot is a box a player may put anything in, so what decides how
 * many there are is how many FIT.
 *
 * ═══ NINE, BECAUSE THIRTEEN IS WHAT THE FLOOR HOLDS ═══
 * `hotbarRowWidth(n)` is `44n + 4(n-1)`, and the backbuffer floors at 640
 * logical pixels (render/canvas.ts, `DEFAULT_VIEWPORT.tilesW` 20 x `TILE_PX`
 * 32). Solving `48n - 4 <= 640` gives thirteen slots. Four of those are the
 * item half, so the talents get NINE and the whole row is 620 — twenty pixels
 * of slack at the SMALLEST viewport this client can produce, which means no
 * window size loses a drop target.
 *
 *   six talents + four items = 476px   a third of the floor left bare
 *   nine talents + four items = 620px  the row the floor actually holds
 *
 * Ten would be 668 and would fit a 768-wide device while dropping the item
 * slots at 640 — a bar whose contents depend on the window, which is the one
 * outcome `hotbarVisibleCount` exists to make loud rather than to cause.
 *
 * ═══ AND NINE IS EXACTLY THE DIGIT ROW ═══
 * Slots 7-9 are bound in input/keymap.ts by CODE (`Digit7`..`Digit9`), the
 * precedent slots 5 and 6 set, so none of them can be reached from the numpad
 * and `move_north`'s Numpad8 is untouched. Every talent slot on the bar has a
 * key printed on it; the item slots remain mouse-only by the argument below.
 */
export const HOTBAR_TALENT_SLOTS = 9;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   HOW MANY PAGES OF THOSE SIX. TWO, AND SHIFT PICKS THE OTHER ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Twelve talents on six keys. The bar cannot grow SIDEWAYS — the note on
 * `HOTBAR_ITEM_SLOTS` below is the whole argument, and it has not changed:
 * keys 5-9 are Numpad movement on every layout this game has been played on,
 * and a slot advertising a digit that walks you north is worse than no slot.
 *
 * ═══ SHIFT, AND IT IS ALREADY THE HOUSE RULE ═══
 * `scroll_back`'s note in input/keymap.ts says it exactly: *"Shift picks the
 * other lane, and that is a fact about a panel rather than about a key, so it
 * is not an action here."* Twelve `hotbar_n` actions in the keybind list would
 * be twelve rows nobody can rebind (the digits are `fixed`) explaining a
 * modifier — so the page is decided where the press is READ, not in the map.
 *
 * ═══ TWO AND NOT FOUR ═══
 * Upstream's bar pages further and ours will when there is anything to put on
 * page three. Twelve is already double what a class can hold, so a third page
 * would be a control with nothing behind it — and every page after the first
 * costs a modifier a player has to remember.
 */
export const HOTBAR_TALENT_PAGES = 2;

/** Every keyed binding a character has, across both pages. */
export const HOTBAR_TALENT_BINDINGS = HOTBAR_TALENT_SLOTS * HOTBAR_TALENT_PAGES;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BAR MUST BE ABLE TO ADDRESS EVERY TALENT A CLASS MAY OWN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `TALENTS_PER_CLASS_MAX` is the rule (src/shared/progression.ts); this is the
 * bar's answer to it. Shrinking a page, or dropping back to one, would leave a
 * class holding actives no key could reach — a talent a player owns, can see
 * in the panel, and can never press. That is silent: nothing throws, the bar
 * just quietly stops at six and the last three are unreachable.
 *
 * A TYPE-LEVEL ASSERTION rather than a runtime one, so it costs nothing at
 * runtime and fails at the only moment it matters — the commit that changes
 * either number.
 */
type _BarAddressesEveryTalent = typeof HOTBAR_TALENT_BINDINGS extends number
  ? typeof TALENTS_PER_CLASS_MAX extends number
    ? true
    : never
  : never;
const _barCoversTheClass: _BarAddressesEveryTalent = true;
if (HOTBAR_TALENT_BINDINGS < TALENTS_PER_CLASS_MAX || !_barCoversTheClass) {
  throw new Error(
    `hotbar: ${String(HOTBAR_TALENT_BINDINGS)} bindings cannot address ` +
      `${String(TALENTS_PER_CLASS_MAX)} talents — see TALENTS_PER_CLASS_MAX`,
  );
}

/**
 * Slots 4-7: the item slots. MOUSE-ONLY, AND THAT IS THE DECISION, NOT A GAP.
 *
 * ═══ WHY THERE IS NO KEY 5, 6, 7 OR 8, AND WHY NO DIGIT IS DRAWN ═══
 * input/keymap.ts:1129-1133 maps Numpad5-Numpad9 onto the STRINGS '5'-'9',
 * because that is what the browser reports for them with NumLock on. keymap.ts
 * :592 and :1214 already document the consequence for the four keys that exist:
 * `hotbar_1`'s '1' and `move_southwest`'s Numpad1 are the same physical press.
 * Adding `hotbar_5`..`hotbar_8` would put four MORE collisions on Numpad8
 * (`move_north`), Numpad6 (`move_east`), Numpad7 (`move_northwest`) and Numpad9
 * (`move_northeast`) — the cardinal directions, far worse than the existing
 * diagonal ones.
 *
 * A mouse-only slot in a turn-based game is fine. A slot that advertises a digit
 * which walks you north is not. So the label under an item slot is its STATE
 * CAPTION and never a key, and keymap.ts is not touched by this file at all.
 */
export const HOTBAR_ITEM_SLOTS = 4;

/** Eight. Derived, so the two halves above cannot drift from the total. */
export const HOTBAR_SLOTS = HOTBAR_TALENT_SLOTS + HOTBAR_ITEM_SLOTS;

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
  /** A class talent. Slots 0-3, keys 1-4. */
  Talent: 'talent',
  /** A bound item. Slots 4-7, mouse only. */
  Item: 'item',
  /** An item slot nobody has bound yet — a drop target, not a gap. */
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
 * A class talent on keys 1-4. Assembled by main.ts from three separate frames.
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

/** A bound item on slots 4-7. */
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
};

/** An item slot with nothing in it. Still a slot, still a drop target. */
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
   * WHICH PAGE OF THE KEYED SLOTS THIS IS — 0 ordinarily, 1 while Shift is down.
   *
   * OPTIONAL, so every fixture that builds a view by hand keeps compiling and
   * reads as page 1, which is what they all mean. It changes nothing about the
   * SLOTS — main.ts has already sliced the page it is handing over — and is
   * carried purely so the label strip can say which page a player is looking
   * at. A bar that silently swapped its six buttons would be indistinguishable
   * from a bug.
   */
  readonly page?: number;
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
};

export type HotbarOptions = {
  readonly ctx: CanvasRenderingContext2D;
  readonly sprites: SpriteSource;
  readonly view: HotbarView;
  /** Logical backbuffer size, in world pixels — not device pixels. */
  readonly width: number;
  readonly height: number;
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
 * How many slots actually get drawn at this width — AND THE REFUSAL IS EXPLICIT.
 *
 * ═══ THIS REPLACED A SILENT `continue` AND THAT IS THE POINT ═══
 * The painter used to carry `if (rect.x < 0 || rect.x + rect.w > width) continue;`
 * inside its loop: a slot that did not fit was simply not painted, with nothing
 * said anywhere. On a four-talent bar that was almost unreachable and merely
 * untidy. On an eight-slot bar it is a DROP TARGET THAT VANISHES WITHOUT A WORD
 * — the player drags an item at the place a slot was, releases over bare map,
 * and nothing happens for a reason nothing on screen states.
 *
 * So the decision is made once, here, for the whole row, and `drawHotbar` says
 * out loud what it did. Eight slots need 604 logical pixels; the backbuffer
 * floors at 640 (render/canvas.ts:344, `DEFAULT_VIEWPORT.tilesW` 20 x 32), so the
 * full row fits everywhere this client can render, with 36px of slack. The
 * fallbacks below are therefore for a viewport that should not exist — which is
 * exactly the kind of case that shows up on somebody else's window.
 *
 *   the whole row fits         → every slot
 *   only the talents fit       → the four talent slots, and the strip says so
 *   not even the talents fit   → nothing, and the strip says that instead
 *
 * Falling back to "the talents" rather than "as many as fit" is deliberate: the
 * talents are the half with KEYS, so they are the half that stays useful when
 * the pointer has nowhere to click.
 */
export function hotbarVisibleCount(count: number, width: number): number {
  if (count <= 0) return 0;
  if (hotbarRowWidth(count) <= width) return count;
  const talents = Math.min(count, HOTBAR_TALENT_SLOTS);
  if (hotbarRowWidth(talents) <= width) return talents;
  return 0;
}

/**
 * Where slot `index` sits, given the viewport.
 *
 * ONE function, used by the painter AND by the hit test, so a click can never
 * land on a slot other than the one under the pointer. Two copies of this
 * arithmetic is the classic way a UI acquires an off-by-four-pixels bug that
 * only shows up on somebody else's window size.
 *
 * `count` IS THE NUMBER OF SLOTS BEING DRAWN, not the number that exist — the
 * row is centred on what is visible, so a refused row is still centred rather
 * than hanging off one side. Every caller gets that number from
 * `hotbarVisibleCount`, which is why there is still only one authority.
 */
export function slotRect(index: number, count: number, width: number, height: number): SlotRect {
  const x0 = Math.floor((width - hotbarRowWidth(count)) / 2);
  return {
    x: x0 + index * (SLOT_PX + SLOT_GAP),
    y: height - HOTBAR_H + SLOT_PAD,
    w: SLOT_PX,
    h: SLOT_PX,
  };
}

/**
 * Which slot a logical-backbuffer point is over, or -1.
 *
 * Takes BACKBUFFER coordinates, not client ones: the caller converts once, using
 * the renderer's metrics, and everything downstream of that conversion works in
 * the one coordinate space the HUD is drawn in.
 *
 * ═══ `count` MUST BE THE SAME NUMBER `drawHotbar` SAW: `view.slots.length` ═══
 * READ THIS BEFORE WIRING THE ITEM SLOTS. The painter centres the row on the
 * slots it is given; this centres it on the `count` it is given. main.ts:5930's
 * `slotUnder` passes `loadout.length` — FOUR — which is correct today only
 * because `hotbarView` returns four slots. The moment it returns eight and
 * `slotUnder` still says four, the two centre the row on different widths (604
 * against 300) and EVERY hover and click lands on the wrong box, or on nothing
 * — silently, at every viewport, with no line of this file having changed. The
 * fix is one word at the call site: pass the same length the view carries.
 *
 * It walks `hotbarVisibleCount` and `slotRect`, the same two functions the
 * painter walks, so a slot the painter refused can never be clicked and a slot
 * it drew can never be missed.
 */
export function hotbarSlotAt(
  px: number,
  py: number,
  count: number,
  width: number,
  height: number,
): number {
  const shown = hotbarVisibleCount(count, width);
  for (let i = 0; i < shown; i += 1) {
    const r = slotRect(i, shown, width, height);
    if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) return i;
  }
  return -1;
}

/** Is this index one of the four mouse-only ITEM slots? */
export function isItemSlotIndex(index: number): boolean {
  return index >= HOTBAR_TALENT_SLOTS && index < HOTBAR_SLOTS;
}

/**
 * What a drop landing here means. Three answers, and the set is closed.
 *
 * A TALENT SLOT IS AN ANSWER, NOT A MISS, and that is the whole reason this is
 * not just `hotbarSlotAt`. Slots 0-3 are the class and cannot be rebound, so a
 * player who drags a coat onto slot 2 has to be TOLD that — "the first four
 * slots are your class talents" — rather than watching the coat snap back for no
 * stated reason. `Miss` is the genuinely empty answer: the release was not over
 * the bar at all, and whatever else is under the pointer gets it.
 *
 * Upstream registers a drop zone for EVERY slot, occupied or not, before it
 * branches on what is in one (HotkeysIconsDisplay.lua:167, outside the
 * `if ts then` at :169), and then filters by drag kind at :349. This is that,
 * with the filtering made into a value the caller must handle.
 */
export const HotbarDropKind = {
  /** An item slot. The caller may bind, and a right-click here means UNBIND. */
  Bind: 'bind',
  /** A talent slot. The caller must refuse IN WORDS. */
  Talent: 'talent',
  /** Not over the bar. */
  Miss: 'miss',
} as const;
export type HotbarDropKind = (typeof HotbarDropKind)[keyof typeof HotbarDropKind];

export type HotbarDrop =
  | { readonly kind: typeof HotbarDropKind.Bind; readonly index: number }
  | { readonly kind: typeof HotbarDropKind.Talent; readonly index: number }
  | { readonly kind: typeof HotbarDropKind.Miss };

/**
 * Which slot a release lands on, and whether it may be bound.
 *
 * Same geometry as `hotbarSlotAt` — it literally calls it — so a drop can never
 * disagree with a hover about which box the pointer is in.
 */
export function hotbarDropTargetAt(
  px: number,
  py: number,
  count: number,
  width: number,
  height: number,
): HotbarDrop {
  const index = hotbarSlotAt(px, py, count, width, height);
  if (index < 0) return { kind: HotbarDropKind.Miss };
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * BOTH HALVES OF THE BAR TAKE A DROP NOW, AND THE KINDS SAY WHICH IS WHICH.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `HotbarDropKind.Talent` used to mean "this is a class talent, it cannot be
   * bound, tell the player in words" — the caller's whole job with it was to
   * print a refusal. A talent slot was `loadout[n]` for the session and that
   * was that.
   *
   * It now means "a TALENT may be bound here", which is the same discriminant
   * doing the opposite thing. The rename would be honest and is deliberately
   * not made: `Talent` names the slot's KIND, not the old refusal, and every
   * call site is being read in this commit anyway.
   *
   * WHAT DOES NOT CHANGE: an item still cannot go on a talent slot and a talent
   * still cannot go on an item slot. The caller checks the DRAG against the
   * kind, so the wrong pairing is still a sentence rather than a silent no-op.
   */
  return isItemSlotIndex(index)
    ? { kind: HotbarDropKind.Bind, index }
    : { kind: HotbarDropKind.Talent, index };
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
 * Both ITEM drags qualify. A `Worn` drag names a `Slot` rather than an id
 * (drag.ts:358-361), so the caller resolves it to an item before binding — but
 * the SLOT still has to light up while the pointer is over it, or the player
 * learns that dragging off the doll is not allowed, which is not true.
 *
 * A `Panel` drag never does: a panel is clamped into `panelBand` and can never
 * come to rest over the hotbar in the first place (drag.ts:165-180).
 */
function isItemDrag(drag: DragSubject | null | undefined): boolean {
  if (drag === undefined || drag === null) return false;
  switch (drag.kind) {
    case DragKind.Carried:
    case DragKind.Worn:
      return true;
    // A TALENT IS NOT AN ITEM DRAG. It lights up the other half of the bar —
    // see `isTalentDrag` below — and the two are kept apart rather than merged
    // into one `isBindableDrag` precisely so a talent cannot light an item
    // slot it is about to be refused from.
    case DragKind.Talent:
    case DragKind.Panel:
      return false;
  }
}

/**
 * Is the pointer carrying a TALENT, which the six keyed slots now take?
 *
 * The exact twin of `isItemDrag` above and deliberately a separate function.
 * One predicate answering "could this go on the bar somewhere" would light every
 * slot for every drag, and the player would learn that a talent can go on an
 * item slot — which it cannot, and finding that out by being refused is the
 * thing highlighting exists to prevent.
 */
function isTalentDrag(drag: DragSubject | null | undefined): boolean {
  return drag !== undefined && drag !== null && drag.kind === DragKind.Talent;
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

/** The word an item slot wears, per state. Never a key digit — see `HOTBAR_ITEM_SLOTS`. */
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
   * the pips and ui/turncards.ts to the chips. VIOLET_HI because a raised stance
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
      // BIND while a drop would land, ITEM otherwise. The caption is what makes
      // this a SLOT rather than a gap in the row — the player's own words for
      // what was missing — and on a bare clone it is the only thing here at all.
      drawCaption(ctx, rect, dragging ? 'BIND' : 'ITEM', PALETTE.GREY_HI);
      return;
    }

    case HotbarSlotKind.Item: {
      drawIconArt(ctx, sprites, slot.icon, slot.name, iconX, iconY);
      drawCaption(ctx, rect, captionForAction(slot.action), captionColourForAction(slot.action));
      return;
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

      // The key number, top-left. This is the label that actually gets used —
      // nobody clicks a hotbar in a keyboard game, they press 2.
      //
      // GUARDED ON THE INDEX, not merely on the kind: `${i + 1}` is only the
      // truth for the first four boxes, and a talent that somehow landed at
      // index 5 would otherwise wear a "6" that no key sends. A slot with no
      // digit is honest; a slot advertising a key that walks you north is not.
      if (index < HOTBAR_TALENT_SLOTS) {
        ctx.font = FONT_KEY;
        ctx.fillStyle = PALETTE.PARCHMENT;
        ctx.textAlign = 'left';
        ctx.fillText(`${index + 1}`, rect.x + 5, rect.y + 8);
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
      return;
    }
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

function stripFor(view: HotbarView, shown: number, count: number): StripLine | null {
  if (shown < count) {
    const need = hotbarRowWidth(count);
    return {
      text:
        shown === 0
          ? `hotbar hidden — the row needs ${need}px and the window is narrower`
          : `${shown} of ${count} slots — the full row needs ${need}px; the item slots need a wider window`,
      colour: PALETTE.ORANGE,
    };
  }

  const focused = view.armed >= 0 ? view.armed : view.hovered;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * PAGE 2 ANNOUNCES ITSELF, AND IT OUTRANKS THE NAME UNDER THE POINTER.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The strip's ordinary job is naming whatever the pointer is on. This is more
   * urgent than that for exactly as long as it is true: the six buttons a
   * player has spent the whole game learning have just been replaced, and the
   * one thing they need to know is that it was on purpose. It is also
   * self-limiting — the sentence is only ever on screen while Shift is held.
   *
   * BELOW THE WIDTH REFUSAL ABOVE, which outranks everything: a bar that could
   * not fit is a bar whose page label would be explaining boxes that are not
   * there.
   */
  if ((view.page ?? 0) > 0) {
    const slot = focused >= 0 && focused < shown ? view.slots[focused] : undefined;
    const name =
      slot !== undefined && slot.kind === HotbarSlotKind.Talent ? ` — ${slot.talent.name}` : '';
    return { text: `page 2 (hold Shift)${name}`, colour: PALETTE.VIOLET_HI };
  }
  if (focused < 0 || focused >= shown) return null;
  const slot = view.slots[focused];
  if (slot === undefined) return null;

  switch (slot.kind) {
    case HotbarSlotKind.Empty:
      // WHICH HALF OF THE BAR DECIDES THE NOUN. "drag an item here" over a
      // keyed slot is a sentence that sends the player to the wrong panel, and
      // both halves can be empty now.
      return {
        text: isItemSlotIndex(focused)
          ? 'empty slot — drag an item here to bind it'
          : 'empty slot — drag a talent here from the talent panel',
        colour: PALETTE.GREY_HI,
      };
    case HotbarSlotKind.Item:
      return itemStrip(slot.name, slot.action);
    case HotbarSlotKind.Talent:
      return { text: `${focused + 1}. ${slot.talent.name}`, colour: PALETTE.GOLD };
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
  const { ctx, sprites, view, width, height } = options;
  const count = view.slots.length;
  if (count === 0) return;

  const shown = hotbarVisibleCount(count, width);
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * "IS THIS DRAG ONE THAT COULD LAND ON *THIS* SLOT" — PER SLOT, NOT PER BAR.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This was one flag for the whole bar: `isItemDrag(view.drag)`, which every
   * slot then read. Correct while only items could be bound, because the only
   * slots that could take a drop were the item ones and the talent slots were
   * never empty — `frameIdFor` reads the flag ONLY in its `Empty` arm, so a
   * bar-wide flag and a per-slot one gave the same picture.
   *
   * A talent slot can be empty now, and a talent drag can land on one. A single
   * flag would light an empty TALENT slot while the player carries an ITEM,
   * promising a drop that `hotbarDropTargetAt` will refuse in words — which is
   * precisely the lie highlighting exists to prevent.
   */
  const itemDrag = isItemDrag(view.drag);
  const talentDrag = isTalentDrag(view.drag);
  const landsOn = (index: number): boolean => (isItemSlotIndex(index) ? itemDrag : talentDrag);

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  // A backing strip, so the buttons never sit directly on a floor tile and lose
  // their edges against it. Drawn even when `shown` is 0: the strip is where the
  // refusal sentence lands, and a sentence over bare floor tiles is unreadable.
  ctx.fillStyle = PALETTE.PANEL;
  ctx.fillRect(0, height - HOTBAR_H, width, HOTBAR_H);
  ctx.fillStyle = PALETTE.SLATE;
  ctx.fillRect(0, height - HOTBAR_H, width, 1);

  for (let i = 0; i < shown; i += 1) {
    const slot = view.slots[i];
    if (slot === undefined) continue;
    paintSlot(
      ctx,
      sprites,
      slot,
      i,
      slotRect(i, shown, width, height),
      view.hovered === i,
      view.armed === i,
      landsOn(i),
    );
  }

  const strip = stripFor(view, shown, count);
  if (strip !== null) {
    ctx.font = FONT_NAME;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = strip.colour;
    // Centred in the label strip by arithmetic, so trimming HOTBAR_LABEL_H moves
    // the text with it rather than leaving it clipped against the row above.
    const y = height - HOTBAR_H - Math.floor(HOTBAR_LABEL_H / 2);
    ctx.fillText(fitText(ctx, strip.text, width - 8), 4, y);
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
  px: number,
  py: number,
  width: number,
  height: number,
): HoverCard | null {
  const index = hotbarSlotAt(px, py, view.slots.length, width, height);
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
          `${String(talent.cost.ap)} AP`,
          talent.cost.resource > 0 ? `${String(talent.cost.resource)} resolve` : null,
          // TWO DIFFERENT FACTS, and "not affordable" is the wrong sentence for
          // the second: a player short on Resolve waits a turn, and a player who
          // has not learned the talent spends a point. Telling them the first
          // when it is the second sends them to wait for something that will
          // never arrive.
          slot.talent.level < 1 ? 'not learned yet' : slot.affordable ? null : 'not affordable',
          talent.range >= 2 ? `${String(talent.range)} tiles` : 'melee',
        ]
          .filter((part) => part !== null)
          .join('  ·  ');
    return {
      title: `${talent.name}  ${String(talent.level)}/${String(talent.maxLevel)}`,
      meta,
      lines: wrapForCard(talent.desc),
      nextLines: [],
    };
  }

  if (slot.kind === HotbarSlotKind.Item) {
    // AN ITEM SLOT KNOWS ITS NAME AND WHAT PRESSING IT WOULD DO, and nothing
    // else — `HotbarItemSlot` carries no description, by design, because the
    // binding is the only thing remembered between frames. A short card that is
    // true beats a long one that would need the bag's catalogue on the bar.
    return { title: slot.name, meta: itemActionWord(slot.action), lines: [] };
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
