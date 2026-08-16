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

import { PALETTE } from '../render/canvas.ts';
import { SLOT_ORDER } from '../../shared/protocol.ts';
import { DragKind } from './drag.ts';
import type { DragSubject } from './drag.ts';
import type { LoadoutTalent, Slot } from '../../shared/protocol.ts';
import type { SpriteSource } from '../render/assets.ts';

/**
 * The authored frame size. `ui_hotbar_slot_*` are all 72x72.
 *
 * ═══ THIS NUMBER IS AN ART CONTRACT AND MAY NOT BE SHRUNK ═══
 * `drawFrame` blits at `sprite.w`/`sprite.h` and IGNORES the rect it is handed —
 * deliberately, because a scaled 72px frame is exactly the resampling the whole
 * integer-scaled backbuffer exists to prevent. So any `SLOT_PX` below 72 leaves
 * a 72-pixel PICTURE sitting over a smaller HIT BOX, with nothing anywhere
 * throwing: clicks along the right and bottom edges would land on the map. The
 * bar was made smaller by trimming the pad and the label strip, which are the
 * only two art-safe levers here.
 */
export const SLOT_PX = 72;
/** The authored icon size. `icon_active_*` and `item_*` are all 64x64. */
const ICON_PX = 64;
/** The authored plate size. `ui_inventory_cell_*` are 40x40. */
const PLATE_PX = 40;
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
 * The count is not this file's to choose — it is `LoadoutMsg.talents.length`,
 * four per class by PLAN.md's MVP cap. It is named here because the ITEM slots
 * begin where the talents end, and because the key digit is only ever drawn on
 * these.
 */
export const HOTBAR_TALENT_SLOTS = 4;

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
const FONT_WIPE = 'bold 20px ui-monospace, Consolas, monospace';
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
const FRAME_IDLE = 'ui_hotbar_slot_idle';
const FRAME_HOVER = 'ui_hotbar_slot_hover';
const FRAME_DISABLED = 'ui_hotbar_slot_disabled';
const CELL_EMPTY = 'ui_inventory_cell_empty';

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
  if (carried.some((item) => item.itemId === itemId)) return ItemSlotAction.Equip;
  return ItemSlotAction.Gone;
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
function frameIdFor(slot: HotbarSlot, hovered: boolean, armed: boolean, dragging: boolean): string {
  switch (slot.kind) {
    case HotbarSlotKind.Empty:
      return dragging ? FRAME_HOVER : FRAME_IDLE;
    case HotbarSlotKind.Item:
      if (isSlotDisabled(slot)) return FRAME_DISABLED;
      return hovered ? FRAME_HOVER : FRAME_IDLE;
    case HotbarSlotKind.Talent:
      if (isSlotDisabled(slot)) return FRAME_DISABLED;
      return hovered || armed ? FRAME_HOVER : FRAME_IDLE;
  }
}

/** The word an item slot wears, per state. Never a key digit — see `HOTBAR_ITEM_SLOTS`. */
function captionForAction(action: ItemSlotAction): string {
  switch (action) {
    case ItemSlotAction.Equip:
      return 'EQUIP';
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
    ctx.drawImage(sprite.image, x, y, sprite.w, sprite.h);
    return;
  }

  ctx.fillStyle = PALETTE.VOID;
  ctx.fillRect(x, y, ICON_PX, ICON_PX);
  ctx.fillStyle = PALETTE.SILVER;
  ctx.font = FONT_WIPE;
  ctx.textAlign = 'center';
  const initials = name
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase())
    .join('')
    .slice(0, 2);
  ctx.fillText(initials, x + ICON_PX / 2, y + ICON_PX / 2);
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
  const sprite = sprites.sprite(CELL_EMPTY);
  if (sprite !== undefined && sprite.w <= ICON_PX && sprite.h <= ICON_PX) {
    ctx.drawImage(
      sprite.image,
      x + Math.floor((ICON_PX - sprite.w) / 2),
      y + Math.floor((ICON_PX - sprite.h) / 2),
      sprite.w,
      sprite.h,
    );
    return;
  }

  const px = x + Math.floor((ICON_PX - PLATE_PX) / 2);
  const py = y + Math.floor((ICON_PX - PLATE_PX) / 2);
  ctx.fillStyle = PALETTE.GREY;
  ctx.fillRect(px, py, PLATE_PX, 1);
  ctx.fillRect(px, py + PLATE_PX - 1, PLATE_PX, 1);
  ctx.fillRect(px, py, 1, PLATE_PX);
  ctx.fillRect(px + PLATE_PX - 1, py, 1, PLATE_PX);
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
  const cx = x + ICON_PX / 2;
  const cy = y + ICON_PX / 2;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, ICON_PX, ICON_PX);
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
function drawFrame(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  id: string,
  rect: SlotRect,
): void {
  const sprite = sprites.sprite(id);
  if (sprite !== undefined) {
    ctx.drawImage(sprite.image, rect.x, rect.y, sprite.w, sprite.h);
    return;
  }
  ctx.fillStyle = PALETTE.PANEL;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.fillStyle = PALETTE.SLATE;
  ctx.fillRect(rect.x, rect.y, rect.w, 1);
  ctx.fillRect(rect.x, rect.y + rect.h - 1, rect.w, 1);
  ctx.fillRect(rect.x, rect.y, 1, rect.h);
  ctx.fillRect(rect.x + rect.w - 1, rect.y, 1, rect.h);
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
  drawFrame(ctx, sprites, frameIdFor(slot, hovered, armed, dragging), rect);

  const iconX = rect.x + Math.round((SLOT_PX - ICON_PX) / 2);
  const iconY = rect.y + Math.round((SLOT_PX - ICON_PX) / 2);

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
function itemStrip(name: string, action: ItemSlotAction): StripLine {
  switch (action) {
    case ItemSlotAction.Equip:
      return { text: `${name} — click to equip`, colour: PALETTE.GOLD };
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
  if (focused < 0 || focused >= shown) return null;
  const slot = view.slots[focused];
  if (slot === undefined) return null;

  switch (slot.kind) {
    case HotbarSlotKind.Empty:
      return { text: 'empty slot — drag an item here to bind it', colour: PALETTE.GREY_HI };
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
  const dragging = isItemDrag(view.drag);

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
      dragging,
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
