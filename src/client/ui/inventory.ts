/**
 * THE INVENTORY PANEL: what you are wearing, what you are carrying, and what
 * putting one on would do to the numbers on your character sheet.
 *
 * ===========================================================================
 * IT IS A DOCK PANEL, NOT A MODAL, AND THAT IS THE WHOLE DESIGN
 * ===========================================================================
 * ToME's `ShowEquipInven` is a registered dialog: `engine/Game.lua:380-381` calls
 * `d.key:setCurrent()` when one opens, so it SEIZES the keyboard, and it then
 * takes ACCEPT, EXIT and the whole letter row for its own list widget
 * (dialogs/ShowInventory.lua:64-73, dialogs/ShowEquipment.lua:57-69). ToME can
 * afford that because ToME is single player and the world is paused while you
 * shop.
 *
 * THIS GAME CANNOT, for the reason ui/charsheet.ts:5-27 and ui/talents.ts:6-33
 * already state twice: five other people are at the barrier, `isBlocking` has no
 * notion of "is reading a menu", and porting that focus capture would mean one
 * player deciding whether to swap a coat holds the whole party until the Bell
 * fires on them. So this is a PANEL. It swallows no keys, no turn verbs and no
 * hotbar slots; a player reading it can still walk, still commit, still hold,
 * still press 1-4; and THE SERVER IS NEVER TOLD IT IS OPEN.
 *
 * That single decision is why `inventoryPanelRect` takes a BAND rather than a
 * viewport — `charSheetRect` (ui/charsheet.ts:559-583) is the model it copies,
 * clause for clause. Clamped between `top` and `bottom`, the panel can never come
 * to rest over the hotbar, the resource strip or the prose lines, so every
 * control the player might reach for stays visible and pressable underneath it.
 *
 * IT IS ANCHORED TO THE BOTTOM OF THAT BAND, and that is the one place it differs
 * from both its siblings. The sheet centres itself in the band and the talent
 * panel is anchored to the top, which is how those two miss each other when both
 * are open (ui/talents.ts:28-33). This is the third surface and `c`, `g` and `i`
 * are three independent toggles, so it takes the one anchor left: on a band tall
 * enough for two panels the two miss each other entirely, and on a short one the
 * paint order in main.ts decides.
 *
 * ===========================================================================
 * ONE SCREEN WITH TWO TABS, AND THE PAIR IS PORTED WHILE THE AXIS IS OURS
 * ===========================================================================
 * ONE SCREEN IS THE PORT AND NOT A SIMPLIFICATION: `SHOW_EQUIPMENT` is literally
 * an alias of `SHOW_INVENTORY` (tome/class/Game.lua:2192 —
 * `SHOW_EQUIPMENT = "SHOW_INVENTORY"`), and both open the same combined
 * `ShowEquipInven` dialog. There is one key and one screen upstream, so there is
 * one key and one screen here.
 *
 * THE TAB PAIR IS PORTED AS A CONTROL: `ShowEquipInven.lua:44-45` builds two
 * `Tab`s and `:103-104` places them side by side above the doll, which is where
 * ours sit. WHAT THE TWO TABS SELECT IS A DEVIATION AND IS LABELLED ONE. Upstream
 * they are Main Set / Off Set — a weapon-set switch — because that dialog is
 * `math.max(800, game.w * 0.8)` wide (:42) and can afford the doll AND the bag
 * side by side with a separator between them (:102-108). Our panel is 320 logical
 * pixels wide, which is exactly four item frames, so the doll and the bag cannot
 * share a row; the tabs select WHICH OF THE TWO you are looking at. We have no
 * second weapon set to switch — there is no weapon slot at all (shared/
 * protocol.ts's `Slot`) — so the upstream axis has nothing to mean here.
 *
 * EQUIPPED IS THE TAB THAT OPENS, and that is ToME's own choice for the doll
 * dialog: `ShowEquipment.lua:54` is `self:setFocus(self.c_doll)`. It is also the
 * only one of the two that is never empty — seven slots are seven slots whether
 * or not anything is in them, while the bag is empty for most of a delve, and a
 * screen that opens onto a blank grid teaches nothing.
 *
 * ===========================================================================
 * THE LAYOUT IS DECIDED BY THE ART, AND THE ART WAS CUT FOR IT
 * ===========================================================================
 * `ui_item_frame_*` is 72x72 and an item icon is 64x64 (ASSETS-REQUIRED.md's
 * "Item and ability icons | 64x64"). 72 - 64 = 8, so the icon insets FOUR pixels
 * into the frame and is blitted 1:1 WITH NO SCALE AND NO CROP. That is ToME's
 * own `EquipDollFrame` arrangement — `ix=3, iy=3, iw=42, ih=42` inside a 48x48
 * frame (modules/tome/load.lua:140), drawn at `x + f_ix, y + f_iy, f_iw, f_ih`
 * (EquipDollFrame.lua:172-174) — with one difference stated plainly: upstream
 * PASSES a width and height to `toScreen` and therefore scales whatever it is
 * given, while ours are equal by construction and nothing is resampled. The rule
 * ui/classpicker.ts:324-354 sets out ("NEVER SCALED") needs no exception here.
 *
 * A sprite TOO BIG for the box it was cut for is refused outright and the letter
 * plate is drawn instead, which is panel.ts:111's own rule for a 9-slice of the
 * wrong size: a cropped icon is a lie about what the item looks like and a scaled
 * one is the only blurred thing on the screen. A sprite SMALLER than its box is
 * centred in it, because that is not a fault — `ui_inventory_cell_empty` is 40x40
 * by design and sits in the middle of the 64-pixel well.
 *
 * FOUR COLUMNS, EXACTLY, AND THE WIDTH IS NOT NEGOTIABLE. 320 - 2 x 8 of inset
 * is 304; four 72-pixel cells with three 5-pixel gaps is 303. There is no
 * three-column arrangement to fall back to, because the cell size comes from the
 * art rather than from the layout — so unlike the talent panel, whose rows
 * reflow, this one is 320 wide or it does not open at all.
 *
 * ===========================================================================
 * NO SCROLLING, NO PAGING, AND THE CAP IS WHAT KEEPS THAT HONEST
 * ===========================================================================
 * ui/charsheet.ts:98-111 refuses scrolling in writing — "a scroll position is
 * state, state needs a scrollbar, a scrollbar needs a hit test" — and
 * ui/talents.ts:84-92 refuses it again. There is exactly ONE scrolling surface in
 * this whole client (the Case Log, and it scrolls by ENTRY INDEX with a text
 * signal rather than with a bar), there is no scrollbar sprite in the manifest,
 * and there is no draggable control anywhere in ui/.
 *
 * TWELVE FITS ON ONE PAGE — three rows of four — AND THE SERVER ENFORCES TWELVE
 * (`INVENTORY_CAP`, src/server/net/gateway.ts:1631-1648, which argues at length
 * that the point of a cap that cannot bind is that `pickup` has a bounded answer
 * at all). So the refusal above costs nothing: there is never a thirteenth thing
 * to scroll to. A bag that somehow arrives longer than twelve — a save written by
 * a build with a different cap — shows its first twelve and SAYS SO in words,
 * taking ui/caselog.ts:467-478's rule that a surface which has quietly stopped
 * showing everything must never make the reader infer it.
 *
 * ===========================================================================
 * THE COMPARISON STRIP DRAWS THE SERVER'S ANSWER AND COMPUTES NOTHING
 * ===========================================================================
 * Every row in the strip is a `{label, value}` pair the SERVER formatted
 * (`CarriedItemView.compare`, src/server/view/projector.ts:1244). This file does
 * no arithmetic on any of them and must never start: eslint blocks src/client/**
 * from importing shared/checkhit, shared/scale and shared/energy, so it could not
 * work the numbers out — and even the subtraction that looks safe is wrong,
 * because `rescaleCombatStats` FLOORS (shared/scale.ts:116) and +3 Strength is
 * worth a different number of points of damage depending on where the total
 * already sits. ui/tooltip.ts:6-16 exists to keep exactly this out of the
 * browser.
 *
 * THE ORDER IS THE SERVER'S ORDER, UNSORTED, which is the same contract
 * ui/charsheet.ts:69-75 keeps for `InspectView.rows`. It is already ToME's own
 * spine: `Object.lua:1280-1287` renders `desc_wielder` as accuracy, armour
 * penetration, physical crit, physical power, THEN armour, armour hardiness,
 * defence — attack first, then defence, each a signed delta — and projector.ts's
 * `COMPARE_ROWS` is that order with our stat block in front of it. A panel that
 * re-ranked the rows would be holding a second opinion about a table it is not
 * allowed to compute.
 *
 * They are drawn in ui/tooltip.ts:244-260's row form — label left in GREY_HI,
 * value right in BONE, both in GOLD when the row is emphasised — because one
 * shape for a stat line means the hover card and this panel cannot drift into two
 * house styles on one screen.
 *
 * ===========================================================================
 * GEOMETRY IS PURE AND SHARED. ONE COPY OF THE ARITHMETIC
 * ===========================================================================
 * `inventoryPanelGeometry` is called by the painter AND by `inventoryPanelHitAt`,
 * and neither takes a context. ui/partypanel.ts:93-99 records what the second
 * copy costs: a button that lands a row above where it is drawn, on somebody
 * else's window size only. ui/contextmenu.ts:24-34 records why a hit test may not
 * hold a context — it would have to remember a rect from the last frame, and a
 * surface that has never been drawn would then swallow clicks at 0,0.
 *
 * THE COMPARISON STRIP'S HEIGHT IS RESERVED FROM THE RECT AND NEVER FROM THE
 * FOCUS, and that is not tidiness. If the strip appeared when a cell was pointed
 * at, the grid's remaining height would shrink at that instant and the tail row
 * would drop — so the cell under the pointer could vanish because it was pointed
 * at. Reserving it from the rect alone makes the grid's placement a function of
 * the panel's size and nothing else, so nothing moves while the pointer does.
 *
 * It draws into the BACKBUFFER at logical scale like every other ui/ module —
 * see the long note at the top of render/canvas.ts.
 */

import { ItemTier, SLOT_ORDER } from '../../shared/protocol.ts';
import { PALETTE } from '../render/canvas.ts';
import {
  drawButton,
  drawHeader,
  drawPanel,
  fitText,
  HEADER_H,
  PANEL_PAD,
  PanelSkin,
} from './panel.ts';
import type {
  CarriedItemView,
  InspectRow,
  InventoryMsg,
  ItemView,
  Slot,
} from '../../shared/protocol.ts';
import type { SpriteSource } from '../render/assets.ts';
import type { PanelRect } from './panel.ts';

// ---------------------------------------------------------------------------
// Geometry constants. See the header before changing any of them.
// ---------------------------------------------------------------------------

/** Chrome lost on each side. Mirrors `panelInner`'s inset, as ui/tooltip.ts does. */
const INSET = PANEL_PAD + 3;

/**
 * THE CELL, THE ICON, AND THE FOUR PIXELS BETWEEN THEM.
 *
 * Both numbers are authored sizes rather than layout choices: `ui_item_frame_*`
 * is 72x72 and every file under `client/public/assets/items/` is 64x64. The inset
 * is DERIVED from the two so it cannot drift — recutting the frame at 80 moves
 * the icon automatically and nothing here has to be edited twice.
 */
const CELL_PX = 72;
const ICON_PX = 64;
const ICON_INSET = (CELL_PX - ICON_PX) / 2;

/** Air between two cells. Four columns of 72 with three of these is 303 of 304. */
const CELL_GAP = 5;
/** FOUR, EXACTLY. See the header: this is decided by the art, not by taste. */
const COLS = 4;

/**
 * How many carried items the grid can show: three rows of four.
 *
 * IT IS THE SERVER'S CAP, RESTATED, NOT A SECOND OPINION. gateway.ts's
 * `INVENTORY_CAP` is 12 and refuses the thirteenth pickup, so this number is what
 * makes "no scrolling" honest rather than a limitation. If the two ever disagree
 * the panel says so in words rather than silently hiding a row — see
 * `carriedCells`.
 */
const CARRIED_MAX = COLS * 3;

/** One text line. 10px glyphs with 2px of leading, matching the Case Log. */
const ROW_H = 12;
/** The tab strip: two boxes and the air under them. */
const TAB_H = 14;
const TAB_ROW_H = TAB_H + 4;
/** Air between the two tabs, so neither swallows the other's click. */
const TAB_GAP = 4;
/** One grid row: a cell, and the gap under it. */
const CELL_ROW_H = CELL_PX + CELL_GAP;
/** A dropped-rows sentence, or "you are carrying nothing". */
const NOTE_ROW_H = ROW_H;

/**
 * THE COMPARISON STRIP: three fixed lines and four for the server's rows.
 *
 * Line 1 is the name (and the DROP control), line 2 is the tier and slot in
 * WORDS, line 3 is the catalogue's one-sentence description, and the rest is
 * `CarriedItemView.compare`. FOUR ROWS is comfortably more than the catalogue
 * produces — the fattest authored item moves an armour number, a hardiness
 * percentage and the two derived rows they feed — and when a fifth ever appears
 * the strip shows three and says how many it held back, because a table cut off
 * without a word looks complete and is not.
 */
const DETAIL_ROWS_MAX = 4;
const DETAIL_H = ROW_H * (3 + DETAIL_ROWS_MAX);

/** The close control, top-right of the header strip. Square, so it is a target. */
const CLOSE_PX = 13;
/** The DROP control, right-aligned on the strip's first line. */
const DROP_W = 42;
const DROP_H = ROW_H;

/**
 * THE PANEL IS EXACTLY THIS WIDE OR IT DOES NOT OPEN.
 *
 * 320 = 2 x 8 of inset + four 72-pixel cells + three 5-pixel gaps + one pixel of
 * slack. Every other panel in this client clamps its width down to fit a narrow
 * viewport; this one cannot, because a column is the size of a PNG. So the
 * minimum and the preferred width are the same number, and a viewport too narrow
 * for it gets no panel and the key that opens it appears to do nothing — which is
 * the honest outcome, and is why `inventoryPanelRect` returns null rather than
 * drawing three columns of clipped frames.
 */
const PANEL_W = INSET * 2 + COLS * CELL_PX + (COLS - 1) * CELL_GAP + 1;
const PANEL_MIN_W = PANEL_W;

/**
 * A panel that cannot hold its header, its tabs and ONE row of cells is not worth
 * drawing.
 *
 * One row rather than three, deliberately, and the comparison strip is NOT
 * counted: the drop policy below removes grid rows from the tail and says so in
 * words, so a short band gives a truthful partial panel. Refusing to open until
 * everything fits would leave a player pressing `i` and seeing nothing at all.
 */
const PANEL_MIN_H = HEADER_H + INSET * 2 + TAB_ROW_H + CELL_ROW_H;

/**
 * Everything at once: header, tabs, three full rows of cells and the strip.
 * DERIVED rather than typed as a literal, so a taller cell or a fifth comparison
 * row cannot leave the panel one line short of its own contents.
 */
const PANEL_MAX_H = HEADER_H + INSET * 2 + TAB_ROW_H + CELL_ROW_H * 3 + DETAIL_H;

/** Air between the panel and the edges of the band it is clamped into. */
const PANEL_MARGIN = 6;

const FONT_NAME = 'bold 10px ui-monospace, Consolas, monospace';
const FONT_BODY = '10px ui-monospace, Consolas, monospace';
const FONT_META = 'bold 10px ui-monospace, Consolas, monospace';
/** The first-letter fallback inside a cell. Non-violet, by rule. */
const FONT_ICON_FALLBACK = 'bold 14px ui-monospace, Consolas, monospace';

/** The title on the header strip. */
const PANEL_TITLE = 'INVENTORY';

/**
 * The strip's own instruction, drawn only while nothing is pointed at.
 *
 * It is not furniture: hover-to-compare and click-to-wear is the one interaction
 * on this screen that cannot be guessed from looking at it, and the line goes
 * away the moment the player has done it once.
 */
const DETAIL_HINT = 'point at an item to see what it changes';
/** The strip's control. A word, because a bin icon would be a new sprite id. */
const DROP_LABEL = 'DROP';

// ---------------------------------------------------------------------------
// Tabs, cells and rows
// ---------------------------------------------------------------------------

/**
 * Which half of `ShowEquipInven` is on screen.
 *
 * A const object plus a derived type rather than an `enum`: `erasableSyntaxOnly`
 * is on and an enum emits runtime code the type-stripping loader refuses.
 */
export const InventoryTab = {
  /** The paper doll — seven slots in `SLOT_ORDER`, empty ones included. */
  Equipped: 'equipped',
  /** The bag — up to twelve things, in the server's own order. */
  Carried: 'carried',
} as const;
export type InventoryTab = (typeof InventoryTab)[keyof typeof InventoryTab];

/** Left to right, which is also the order the hit test answers in. */
const TAB_ORDER: readonly InventoryTab[] = [InventoryTab.Equipped, InventoryTab.Carried];

/**
 * ONE CELL OF THE GRID: something worn, something carried, or a slot with
 * nothing in it.
 *
 * AN EMPTY CELL EXISTS ONLY ON THE DOLL. A bag has no empty places — twelve is a
 * cap rather than a shape — so the carried grid simply stops, while the doll
 * always draws all seven slots whether or not they are filled. That is ToME's own
 * arrangement: `EquipDollFrame:display` (EquipDollFrame.lua:165-177) paints the
 * frame unconditionally and then paints EITHER the object OR `bg_empty` inside
 * it, where `bg_empty` is the per-inventory `equipdoll_back` picture defined at
 * modules/tome/load.lua:120-134.
 */
export type InventoryCell =
  | {
      readonly kind: 'empty';
      /** Which slot is unfilled. Drawn as a word in the strip. */
      readonly slot: Slot;
    }
  | {
      readonly kind: 'item';
      /** A catalogue id — what `equip`, `unequip` and `drop` name. */
      readonly itemId: string;
      readonly name: string;
      /** An asset KEY off the wire, never derived from the name. */
      readonly icon: string;
      readonly tier: ItemTier;
      readonly slot: Slot;
      /**
       * TRUE ON THE DOLL, FALSE IN THE BAG — so a click knows whether it means
       * `unequip` or `equip` without the caller having to remember which tab it
       * was looking at when the menu was built.
       */
      readonly worn: boolean;
    };

/**
 * WHAT THE STRIP IS ABOUT: the last thing the pointer was over.
 *
 * ═══ THE CALLER MUST NOT CLEAR THIS WHEN THE POINTER LEAVES A CELL ═══
 * The DROP control lives inside the strip, so the pointer has to travel from the
 * cell to the strip to reach it. A focus that cleared on leaving the grid would
 * empty the strip on the way there, and the control would be unreachable by
 * construction — the mouse can only get to it by leaving the thing it is about.
 * So: set it on hover, replace it on the next hover, and never clear it.
 */
export type InventoryFocus =
  | { readonly kind: 'item'; readonly itemId: string }
  | { readonly kind: 'slot'; readonly slot: Slot };

/** True when two focuses name the same thing. One copy, so the ring and the strip agree. */
function sameFocus(a: InventoryFocus | null, b: InventoryFocus | null): boolean {
  if (a === null || b === null) return false;
  if (a.kind === 'item' && b.kind === 'item') return a.itemId === b.itemId;
  if (a.kind === 'slot' && b.kind === 'slot') return a.slot === b.slot;
  return false;
}

export const InventoryRowKind = {
  /** The `[EQUIPPED]` / `[CARRIED]` pair. Always the first row. */
  Tabs: 'tabs',
  /** Up to four cells, left to right. The workhorse. */
  Cells: 'cells',
  /** The comparison strip. Always the last row, and always the same height. */
  Detail: 'detail',
  /** A sentence about the panel itself — what was dropped, or that the bag is empty. */
  Note: 'note',
} as const;
export type InventoryRowKind = (typeof InventoryRowKind)[keyof typeof InventoryRowKind];

export type InventoryRow =
  | {
      readonly kind: typeof InventoryRowKind.Tabs;
      readonly tab: InventoryTab;
      /** How many of the seven slots are filled. Drawn on the tab, never inferred. */
      readonly wornCount: number;
      readonly carriedCount: number;
    }
  | { readonly kind: typeof InventoryRowKind.Cells; readonly cells: readonly InventoryCell[] }
  | {
      readonly kind: typeof InventoryRowKind.Detail;
      /** The item's name, the slot's name, or '' when nothing is focused. */
      readonly title: string;
      /** "uncommon · body", "empty", or the hint. Never a number. */
      readonly meta: string;
      /** `ItemView.desc` — the catalogue's one sentence — or ''. */
      readonly desc: string;
      /** THE SERVER'S ROWS, IN THE SERVER'S ORDER. A prefix of them when capped. */
      readonly rows: readonly InspectRow[];
      /** How many the cap held back. 0 in every ordinary case. */
      readonly hiddenRows: number;
      /** What DROP would drop, or null — a worn item and an empty slot have none. */
      readonly dropId: string | null;
    }
  | { readonly kind: typeof InventoryRowKind.Note; readonly text: string };

/**
 * Everything the panel is built from. One frame and two pieces of local state.
 *
 * `inventory` IS THE VIEWER'S OWN AND CANNOT BE ANYBODY ELSE'S: `InventoryMsg` is
 * a `ViewerMsg`, and `CarriedItemView.compare` is a delta against THIS
 * recipient's paper doll — the same coat is +4 Armour to a bare Watchman and
 * nothing at all to one already wearing it. There is no shape of this panel that
 * is correct for two people.
 */
export type InventoryPanelView = {
  /** The `inventory` frame, or null before the first one arrives. */
  readonly inventory: InventoryMsg | null;
  readonly tab: InventoryTab;
  /** The strip's subject. See `InventoryFocus` — the caller must not clear it. */
  readonly focus: InventoryFocus | null;
};

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** The doll, in `SLOT_ORDER`, empty slots included. Seven cells, always. */
function equippedCells(inventory: InventoryMsg): readonly InventoryCell[] {
  return SLOT_ORDER.map((slot): InventoryCell => {
    const item: ItemView | undefined = inventory.equipped[slot];
    if (item === undefined) return { kind: 'empty', slot };
    return {
      kind: 'item',
      itemId: item.itemId,
      name: item.name,
      icon: item.icon,
      tier: item.tier,
      slot,
      worn: true,
    };
  });
}

/** The bag, in the server's own order, capped at what one page holds. */
function carriedCells(inventory: InventoryMsg): readonly InventoryCell[] {
  return inventory.carried.slice(0, CARRIED_MAX).map((item: CarriedItemView): InventoryCell => ({
    kind: 'item',
    itemId: item.itemId,
    name: item.name,
    icon: item.icon,
    tier: item.tier,
    // NAMED ON THE ITEM because a bag has no key to read it off — `ItemView`
    // deliberately omits `slot` for the doll, where the map KEY is the slot.
    slot: item.slot,
    worn: false,
  }));
}

/** Break a flat list of cells into rows of at most `COLS`. */
function intoRows(cells: readonly InventoryCell[]): readonly InventoryRow[] {
  const rows: InventoryRow[] = [];
  for (let i = 0; i < cells.length; i += COLS) {
    rows.push({ kind: InventoryRowKind.Cells, cells: cells.slice(i, i + COLS) });
  }
  return rows;
}

/** The tier, as a word. A switch, so a fourth `ItemTier` is a compile error. */
function tierWord(tier: ItemTier): string {
  switch (tier) {
    case ItemTier.Common:
      return 'common';
    case ItemTier.Uncommon:
      return 'uncommon';
    case ItemTier.Rare:
      return 'rare';
  }
}

/**
 * THE COMPARISON STRIP, from whatever the pointer was last over.
 *
 * A CARRIED ITEM IS THE ONLY CASE WITH NUMBERS IN IT, and that is the wire's
 * shape rather than a decision here: `compare` lives on `CarriedItemView` and not
 * on `ItemView`, because "what would change if I put this on" is meaningless for
 * something already on. A worn item gets its name, its tier and its sentence; the
 * player who wants its contribution takes it off, or reads the character sheet,
 * which is the screen that owns totals.
 */
function detailRow(view: InventoryPanelView, inventory: InventoryMsg | null): InventoryRow {
  const blank = {
    kind: InventoryRowKind.Detail,
    title: '',
    meta: DETAIL_HINT,
    desc: '',
    rows: [] as readonly InspectRow[],
    hiddenRows: 0,
    dropId: null,
  } as const;

  const focus = view.focus;
  if (focus === null || inventory === null) return blank;

  if (focus.kind === 'slot') {
    // An empty slot is worth a line: it is where the player learns that `offhand`
    // and `trinket` are places things can go, which nothing else on screen says.
    return {
      kind: InventoryRowKind.Detail,
      title: focus.slot,
      meta: 'empty',
      desc: '',
      rows: [],
      hiddenRows: 0,
      dropId: null,
    };
  }

  const carried = inventory.carried.find((item) => item.itemId === focus.itemId);
  if (carried !== undefined) {
    const all = carried.compare;
    // THE CAP, AND IT KEEPS A WHOLE PREFIX. Showing four of five and saying "1
    // more" is a table that has stopped short and admits it; showing four of five
    // silently is a table that looks complete.
    const capped = all.length > DETAIL_ROWS_MAX;
    return {
      kind: InventoryRowKind.Detail,
      title: carried.name,
      meta: `${tierWord(carried.tier)} · ${carried.slot}`,
      desc: carried.desc,
      rows: capped ? all.slice(0, DETAIL_ROWS_MAX - 1) : all,
      hiddenRows: capped ? all.length - (DETAIL_ROWS_MAX - 1) : 0,
      // DROP IS OFFERED FOR A CARRIED ITEM ONLY. ToME's `playerDrop`
      // (Game.lua:2173-2176 -> `DROP_FLOOR`) drops out of INVEN, and taking a
      // worn thing off is a separate act there and here.
      dropId: carried.itemId,
    };
  }

  for (const slot of SLOT_ORDER) {
    const worn = inventory.equipped[slot];
    if (worn === undefined || worn.itemId !== focus.itemId) continue;
    return {
      kind: InventoryRowKind.Detail,
      title: worn.name,
      meta: `${tierWord(worn.tier)} · ${slot} · worn`,
      desc: worn.desc,
      rows: [],
      hiddenRows: 0,
      dropId: null,
    };
  }

  // The focused item has left the inventory — it was equipped, dropped or taken
  // by somebody else between the hover and this frame. The hint is the honest
  // answer; a stale name would be a panel describing something that is gone.
  return blank;
}

/**
 * THE PANEL, AS AN ORDERED LIST OF LINES. Pure, and the whole port lives here.
 *
 * THE ORDER INSIDE EACH TAB IS THE SERVER'S AND IS NEVER SORTED. The doll is
 * walked in `SLOT_ORDER`, which is the gear FOLD's order on the server
 * (src/server/content/items.ts) and the reading order here; the bag is in the
 * order the frame carries, which is the order things were picked up in. Sorting
 * either — by tier, by name — would mean the cell under a player's finger moved
 * because a number changed somewhere else.
 */
export function inventoryPanelRows(view: InventoryPanelView): readonly InventoryRow[] {
  const inventory = view.inventory;
  const rows: InventoryRow[] = [
    {
      kind: InventoryRowKind.Tabs,
      tab: view.tab,
      wornCount: inventory === null ? 0 : Object.keys(inventory.equipped).length,
      carriedCount: inventory === null ? 0 : inventory.carried.length,
    },
  ];

  if (inventory === null) {
    // NEVER A BLANK BOX. The frame is unicast and only when there is something to
    // say — a player carrying and wearing nothing is never sent one at all
    // (src/server/net/gateway.ts's `inventoryKey` memo) — so this is the ordinary
    // state of a fresh detective and it must read as one rather than as a panel
    // that failed to load.
    rows.push({
      kind: InventoryRowKind.Note,
      text: 'nothing worn, nothing carried',
    });
    rows.push(detailRow(view, null));
    return rows;
  }

  if (view.tab === InventoryTab.Equipped) {
    rows.push(...intoRows(equippedCells(inventory)));
  } else {
    const cells = carriedCells(inventory);
    rows.push(...intoRows(cells));
    if (cells.length === 0) {
      rows.push({ kind: InventoryRowKind.Note, text: 'you are carrying nothing' });
    } else if (inventory.carried.length > cells.length) {
      // The server caps at twelve, so this is unreachable in ordinary play. It is
      // still said out loud rather than assumed: the alternative is a build whose
      // cap has moved quietly hiding a row that the player watched arrive.
      const more = inventory.carried.length - cells.length;
      rows.push({
        kind: InventoryRowKind.Note,
        text: `${String(more)} more carried — the page holds ${String(CARRIED_MAX)}`,
      });
    }
  }

  rows.push(detailRow(view, inventory));
  return rows;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * WHERE THE PANEL GOES, or null when the band it was given cannot hold one.
 *
 * CLAMPED INTO THE BAND, which is the point: `top` is the first free pixel under
 * the top HUD and `bottom` is the first pixel of the bottom bands, so the panel
 * can never come to rest over the hotbar, the resource strip or the prose lines.
 * `height` is the logical viewport and clamps `bottom` in turn — a caller that
 * computed a band against a stale viewport size cannot push the panel off the
 * bottom of the screen, where its close button would be unreachable.
 *
 * CENTRED HORIZONTALLY because both sides are taken (ui/partypanel.ts holds the
 * left, the Case Log holds the right), and ANCHORED TO THE BOTTOM of the band
 * because the sheet is centred in it and the talent panel is pinned to the top —
 * see the header.
 *
 * THE WIDTH IS NEVER CLAMPED DOWN, unlike every sibling's. A column is the size
 * of a PNG, so there is no narrower arrangement to degrade to: too narrow is a
 * null, not three columns.
 */
export function inventoryPanelRect(options: {
  /** Logical backbuffer width, in world pixels — not device pixels. */
  readonly width: number;
  /** Logical backbuffer height. Clamps `bottom`; see above. */
  readonly height: number;
  /** First free pixel under the top HUD. */
  readonly top: number;
  /** First pixel of the bottom bands (the hotbar and the prose lines). */
  readonly bottom: number;
}): PanelRect | null {
  const { width, height, top } = options;
  const bottom = Math.min(options.bottom, height);
  const band = bottom - top;
  if (band < PANEL_MIN_H + PANEL_MARGIN * 2) return null;
  if (width < PANEL_MIN_W + PANEL_MARGIN * 2) return null;

  const w = PANEL_W;
  const h = Math.min(PANEL_MAX_H, band - PANEL_MARGIN * 2);
  return { x: Math.floor((width - w) / 2), y: bottom - PANEL_MARGIN - h, w, h };
}

/**
 * THE CLOSE CONTROL'S RECT — the ONE copy of that arithmetic.
 *
 * Depends on the panel rect alone and never on the rows, which is what lets the
 * hit test answer for a panel whose contents have not been computed this frame.
 */
function closeRect(rect: PanelRect): PanelRect {
  return {
    x: rect.x + rect.w - PANEL_PAD - CLOSE_PX,
    y: rect.y + Math.floor((HEADER_H - CLOSE_PX) / 2),
    w: CLOSE_PX,
    h: CLOSE_PX,
  };
}

/** How many vertical pixels one row wants. */
function rowHeight(row: InventoryRow): number {
  switch (row.kind) {
    case InventoryRowKind.Tabs:
      return TAB_ROW_H;
    case InventoryRowKind.Cells:
      return CELL_ROW_H;
    case InventoryRowKind.Detail:
      return DETAIL_H;
    case InventoryRowKind.Note:
      return NOTE_ROW_H;
  }
}

/** One row, placed, with whatever controls it carries. */
export type PlacedInventoryRow = {
  readonly row: InventoryRow;
  readonly rect: PanelRect;
  /** Cell boxes in the row's own order. Empty for every row but `Cells`. */
  readonly cells: readonly PanelRect[];
  /** The two tab boxes, in `TAB_ORDER`. Empty for every row but `Tabs`. */
  readonly tabs: readonly PanelRect[];
  /** The strip's DROP control, or null when there is nothing to drop. */
  readonly drop: PanelRect | null;
};

export type InventoryPanelGeometry = {
  readonly close: PanelRect;
  /** Rows in reading order, top to bottom. */
  readonly placed: readonly PlacedInventoryRow[];
};

/** The four cell boxes of one grid row. One copy, read by the painter and the pointer. */
function cellRects(row: PanelRect, count: number): readonly PanelRect[] {
  const boxes: PanelRect[] = [];
  for (let i = 0; i < count; i += 1) {
    boxes.push({
      x: row.x + i * (CELL_PX + CELL_GAP),
      y: row.y,
      w: CELL_PX,
      h: CELL_PX,
    });
  }
  return boxes;
}

/** The two tab boxes. Positional, so a click names a tab without reading state. */
function tabRects(row: PanelRect): readonly PanelRect[] {
  const w = Math.floor((row.w - TAB_GAP) / 2);
  return TAB_ORDER.map((_tab, index) => ({
    x: row.x + index * (w + TAB_GAP),
    y: row.y,
    w,
    h: TAB_H,
  }));
}

/**
 * EVERYTHING INSIDE THE PANEL, IN ONE PASS. The painter's only source of truth
 * about where a row lands, and the owner of the drop policy.
 *
 * ═══ THE STRIP IS RESERVED FROM THE RECT, NOT FROM THE CONTENTS ═══
 * See the header. Whether the comparison strip gets its 84 pixels is decided by
 * how tall the panel is and by nothing else, so the grid's placement is a pure
 * function of the panel's size — hovering a cell can never move the cell under
 * the pointer, and nothing oscillates.
 *
 * Grid rows are placed top-down and the TAIL is dropped when the band runs out.
 * Never the middle, and never half a row: a cell cut off below its icon would
 * still look pressable. When anything is dropped a NOTE takes the next line and
 * says how many went (ui/caselog.ts:467-478, ui/charsheet.ts:615).
 */
export function inventoryPanelGeometry(
  rect: PanelRect,
  rows: readonly InventoryRow[],
): InventoryPanelGeometry {
  const close = closeRect(rect);
  const x = rect.x + INSET;
  const innerW = Math.max(0, rect.w - INSET * 2);
  const top = rect.y + HEADER_H + INSET;
  const bottom = rect.y + rect.h - INSET;

  const detail = rows.find((row) => row.kind === InventoryRowKind.Detail);
  // ROOM FOR THE STRIP MEANS ROOM FOR THE STRIP AND ONE ROW OF CELLS. A panel
  // that spent its whole height on a comparison of an item it could no longer
  // show would be a comparison with nothing to compare.
  const room = bottom - top - TAB_ROW_H;
  const stripped = detail !== undefined && room >= CELL_ROW_H + DETAIL_H;
  const limit = stripped ? bottom - DETAIL_H : bottom;

  const placed: PlacedInventoryRow[] = [];
  let cursor = top;
  let droppedCells = 0;

  for (const row of rows) {
    if (row.kind === InventoryRowKind.Detail) continue;
    const h = rowHeight(row);
    if (cursor + h > limit) {
      if (row.kind === InventoryRowKind.Cells) droppedCells += row.cells.length;
      continue;
    }
    const rowRect: PanelRect = { x, y: cursor, w: innerW, h };
    placed.push({
      row,
      rect: rowRect,
      cells: row.kind === InventoryRowKind.Cells ? cellRects(rowRect, row.cells.length) : [],
      tabs: row.kind === InventoryRowKind.Tabs ? tabRects(rowRect) : [],
      drop: null,
    });
    cursor += h;
  }

  // ═══ EVERYTHING HELD BACK IS SAID OUT LOUD, INCLUDING THE STRIP ITSELF ═══
  // Both of these are ui/caselog.ts:467-478's rule. The second one is the easier
  // of the two to forget and the worse of the two to leave silent: a panel that
  // had quietly stopped comparing items would look exactly like a panel whose
  // comparison happened to be empty, which is a real answer this frame can give.
  const held: string[] = [];
  if (droppedCells > 0) held.push(`${String(droppedCells)} hidden — panel too small`);
  if (detail !== undefined && !stripped) held.push('comparison hidden — panel too small');

  for (const text of held) {
    if (cursor + NOTE_ROW_H > limit) break;
    placed.push({
      row: { kind: InventoryRowKind.Note, text },
      rect: { x, y: cursor, w: innerW, h: NOTE_ROW_H },
      cells: [],
      tabs: [],
      drop: null,
    });
    cursor += NOTE_ROW_H;
  }

  // The strip LAST and at the bottom of the panel, so it holds still while the
  // grid above it grows and shrinks. ToME puts its description zone beside the
  // list rather than under it (ShowInventory.lua:37, :56-60) because an 800-pixel
  // dialog can afford two columns; at 320 the only free edge is the bottom one.
  if (detail !== undefined && stripped) {
    const stripRect: PanelRect = { x, y: bottom - DETAIL_H, w: innerW, h: DETAIL_H };
    placed.push({
      row: detail,
      rect: stripRect,
      cells: [],
      tabs: [],
      drop:
        detail.kind === InventoryRowKind.Detail && detail.dropId !== null
          ? {
              x: stripRect.x + stripRect.w - DROP_W,
              y: stripRect.y,
              w: DROP_W,
              h: DROP_H,
            }
          : null,
    });
  }

  return { close, placed };
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

export const InventoryHitKind = {
  /** The × on the header. The mouse's copy of the key that opened the panel. */
  Close: 'close',
  /** One of the two tabs. Positional — the caller switches, nothing is sent. */
  Tab: 'tab',
  /** A filled cell. `worn` says whether the caller means `unequip` or `equip`. */
  Item: 'item',
  /** An unfilled slot on the doll. Nothing to do; it swallows the click. */
  EmptySlot: 'empty_slot',
  /** The strip's DROP control. Only ever offered for a CARRIED item. */
  Drop: 'drop',
} as const;
export type InventoryHitKind = (typeof InventoryHitKind)[keyof typeof InventoryHitKind];

export type InventoryHit =
  | { readonly kind: typeof InventoryHitKind.Close }
  | { readonly kind: typeof InventoryHitKind.Tab; readonly tab: InventoryTab }
  | {
      readonly kind: typeof InventoryHitKind.Item;
      readonly itemId: string;
      readonly slot: Slot;
      /** True on the doll. The caller sends `unequip` for one and `equip` for the other. */
      readonly worn: boolean;
    }
  | { readonly kind: typeof InventoryHitKind.EmptySlot; readonly slot: Slot }
  | { readonly kind: typeof InventoryHitKind.Drop; readonly itemId: string };

/**
 * What a LOGICAL backbuffer point is over, or null.
 *
 * NULL MEANS "ON THE PANEL, BUT NOT ON ANYTHING" and never "fall through" — the
 * caller swallows the click either way, exactly as it does for the character
 * sheet. It reads the SAME geometry the painter drew with, which is the whole
 * reason `inventoryPanelGeometry` takes no context.
 */
export function inventoryPanelHitAt(
  rect: PanelRect,
  rows: readonly InventoryRow[],
  px: number,
  py: number,
): InventoryHit | null {
  const inside = (r: PanelRect): boolean =>
    px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;

  const geometry = inventoryPanelGeometry(rect, rows);
  if (inside(geometry.close)) return { kind: InventoryHitKind.Close };

  for (const placed of geometry.placed) {
    // THE DROP CONTROL FIRST: it sits inside the strip's own rect, so testing the
    // strip first would make the button unreachable while looking pressable.
    if (placed.drop !== null && inside(placed.drop)) {
      const row = placed.row;
      if (row.kind === InventoryRowKind.Detail && row.dropId !== null) {
        return { kind: InventoryHitKind.Drop, itemId: row.dropId };
      }
    }

    for (let i = 0; i < placed.tabs.length; i += 1) {
      const box = placed.tabs[i];
      const tab = TAB_ORDER[i];
      if (box === undefined || tab === undefined || !inside(box)) continue;
      return { kind: InventoryHitKind.Tab, tab };
    }

    if (placed.row.kind !== InventoryRowKind.Cells) continue;
    for (let i = 0; i < placed.cells.length; i += 1) {
      const box = placed.cells[i];
      const cell = placed.row.cells[i];
      if (box === undefined || cell === undefined || !inside(box)) continue;
      if (cell.kind === 'empty') return { kind: InventoryHitKind.EmptySlot, slot: cell.slot };
      return {
        kind: InventoryHitKind.Item,
        itemId: cell.itemId,
        slot: cell.slot,
        worn: cell.worn,
      };
    }
  }
  return null;
}

/**
 * The focus a hit would set, or null when the hit is not about a thing.
 *
 * EXPORTED SO THE CALLER DOES NOT WRITE THIS TWICE. main.ts sets the focus on
 * hover and the same rule has to hold for a click; two copies would be two
 * answers to "what is the strip about", and the one that drifts would be the one
 * the DROP control reads.
 */
export function focusForHit(hit: InventoryHit | null): InventoryFocus | null {
  if (hit === null) return null;
  if (hit.kind === InventoryHitKind.Item) return { kind: 'item', itemId: hit.itemId };
  if (hit.kind === InventoryHitKind.EmptySlot) return { kind: 'slot', slot: hit.slot };
  return null;
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

/**
 * THE FRAME BEHIND A CELL, chosen by a SWITCH rather than assembled from the
 * tier.
 *
 * A template literal would be a sprite key built from a wire field, which
 * test/client/assets.test.ts:285-313 pins against for every panel it knows about
 * and which ToME itself got away with only because it ships a fallback PNG
 * (Birther.lua:47-48's `t.name:lower():gsub(...)`). We ship none —
 * client/public/assets/ is gitignored wholesale — so every id this file can ask
 * for is written out here, greppable, and exhaustive over `ItemTier`.
 *
 * THE `epic` AND `legendary` FRAMES ON DISK ARE DELIBERATELY UNUSED. There are
 * five in tools/gen_ui_assets.py and three tiers on the wire; the extra two are
 * art waiting for a rarity that does not exist, and inventing a fourth tier here
 * to spend them would be inventing content in a renderer.
 */
function frameIdFor(tier: ItemTier): string {
  switch (tier) {
    case ItemTier.Common:
      return 'ui_item_frame_common';
    case ItemTier.Uncommon:
      return 'ui_item_frame_uncommon';
    case ItemTier.Rare:
      return 'ui_item_frame_rare';
  }
}

/** A traced 1px box. The fallback for every piece of cell art, as panel.ts does. */
function traceBox(ctx: CanvasRenderingContext2D, box: PanelRect, colour: string): void {
  if (box.w <= 0 || box.h <= 0) return;
  ctx.fillStyle = colour;
  ctx.fillRect(box.x, box.y, box.w, 1);
  ctx.fillRect(box.x, box.y + box.h - 1, box.w, 1);
  ctx.fillRect(box.x, box.y, 1, box.h);
  ctx.fillRect(box.x + box.w - 1, box.y, 1, box.h);
}

/** Blit a sprite 1:1 at its authored size, centred in `box`. Returns false if it is missing. */
function blitCentred(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  id: string,
  box: PanelRect,
): boolean {
  const sprite = sprites.sprite(id);
  if (sprite === undefined) return false;
  // NEVER SCALED AND NEVER CROPPED. A sprite that does not fit the box it was cut
  // for is a pipeline fault, and drawing a fraction of it would hide that fault
  // behind something that looks almost right — panel.ts:111 refuses a 9-slice of
  // the wrong size for the same reason.
  if (sprite.w > box.w || sprite.h > box.h) return false;
  ctx.drawImage(
    sprite.image,
    box.x + Math.floor((box.w - sprite.w) / 2),
    box.y + Math.floor((box.h - sprite.h) / 2),
    sprite.w,
    sprite.h,
  );
  return true;
}

/**
 * ONE CELL: the frame, then either the icon or the empty plate, then the ring.
 *
 * THE FRAME IS DRAWN EITHER WAY, filled or not, which is EquipDollFrame.lua:165-
 * 170 verbatim — `bg` (or `bg_sel` when focused) goes down before anything is
 * asked about the object. It is what makes a cell read as a PLACE rather than as
 * a picture floating on a panel.
 *
 * THE ICON IS 64x64 AT 1:1 INSIDE A 72x72 FRAME, four pixels in on every side —
 * load.lua:140's `ix=3, iy=3, iw=42, ih=42` in a 48x48 frame, at our sizes. An
 * icon of any other size falls through to the letter plate rather than being
 * cropped or scaled: see `blitCentred`.
 *
 * THE FALLBACK IS A LETTER, NOT THE MISSING-ASSET BOX, for the reason
 * ui/hotbar.ts:193-201 gives for its own initials — twelve identical violet error
 * squares would make the panel unreadable, and on a clone with no art at all that
 * is the ONLY state.
 */
function drawCell(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  cell: InventoryCell,
  box: PanelRect,
  focused: boolean,
  hovered: boolean,
): void {
  ctx.fillStyle = PALETTE.VOID;
  ctx.fillRect(box.x, box.y, box.w, box.h);

  // The frame. An empty slot wears the COMMON frame, which is the neutral grey
  // one — upstream has a single `itemframe48.png` for every slot and every
  // rarity (load.lua:140), so this is the closest thing to "no rarity" we have.
  const frameId = cell.kind === 'item' ? frameIdFor(cell.tier) : frameIdFor(ItemTier.Common);
  if (!blitCentred(ctx, sprites, frameId, box)) traceBox(ctx, box, PALETTE.SLATE);

  const well: PanelRect = {
    x: box.x + ICON_INSET,
    y: box.y + ICON_INSET,
    w: ICON_PX,
    h: ICON_PX,
  };

  if (cell.kind === 'empty') {
    // ToME's `bg_empty`: the per-slot backing picture, drawn INSIDE the frame
    // exactly where the object would have gone (EquipDollFrame.lua:175-177,
    // driven by the `equipdoll_back` handed to `defineInventory` at
    // load.lua:120-134). Ours is one plate for all seven slots, because our slots
    // have no silhouettes cut for them; the slot's NAME is in the strip instead.
    if (!blitCentred(ctx, sprites, 'ui_inventory_cell_empty', well)) {
      ctx.font = FONT_BODY;
      ctx.textAlign = 'center';
      ctx.fillStyle = PALETTE.GREY;
      ctx.fillText(cell.slot, well.x + well.w / 2, well.y + well.h / 2);
      ctx.textAlign = 'left';
    }
  } else if (!blitCentred(ctx, sprites, cell.icon, well)) {
    ctx.font = FONT_ICON_FALLBACK;
    ctx.textAlign = 'center';
    ctx.fillStyle = PALETTE.SILVER;
    ctx.fillText(
      (cell.name.charAt(0) || '?').toUpperCase(),
      well.x + well.w / 2,
      well.y + well.h / 2,
    );
    ctx.textAlign = 'left';
  }

  // TWO PIXELS FOCUSED, ONE UNDER THE POINTER, NOTHING OTHERWISE — a thickness
  // rather than a third colour, which is ui/classpicker.ts:403-411's trick and
  // survives greyscale and the corner of an eye. `bg_sel` is upstream's own
  // version of the same signal (EquipDollFrame.lua:166-167).
  const ring = focused ? 2 : hovered ? 1 : 0;
  if (ring > 0) {
    ctx.fillStyle = focused ? PALETTE.GOLD : PALETTE.PARCHMENT;
    ctx.fillRect(box.x, box.y, box.w, ring);
    ctx.fillRect(box.x, box.y + box.h - ring, box.w, ring);
    ctx.fillRect(box.x, box.y, ring, box.h);
    ctx.fillRect(box.x + box.w - ring, box.y, ring, box.h);
  }
}

/**
 * The comparison strip.
 *
 * EVERY NUMBER HERE IS A STRING OFF THE WIRE. There is no arithmetic in this
 * function and there must never be — see the header, and `CarriedItemView.compare`
 * in shared/protocol.ts, which spells out that a browser doing the subtraction
 * would be confidently wrong rather than merely redundant.
 *
 * THE ROW FORM IS ui/tooltip.ts:244-260's, deliberately shared: label left in
 * GREY_HI, value right in BONE, both GOLD when `emphasis` is set. One shape for a
 * stat line on the two surfaces that draw stat lines.
 */
function drawDetail(
  ctx: CanvasRenderingContext2D,
  placed: PlacedInventoryRow,
  hoveredDrop: boolean,
): void {
  const row = placed.row;
  if (row.kind !== InventoryRowKind.Detail) return;
  const { rect } = placed;
  const right = rect.x + rect.w;

  // A rule above the strip, so it reads as a different KIND of thing from the
  // grid rather than as a fourth row of something.
  ctx.fillStyle = PALETTE.SLATE;
  ctx.fillRect(rect.x, rect.y - 2, rect.w, 1);

  let y = rect.y + ROW_H / 2;
  const titleW = placed.drop === null ? rect.w : Math.max(0, rect.w - DROP_W - 4);

  if (row.title !== '') {
    ctx.font = FONT_NAME;
    ctx.fillStyle = PALETTE.PARCHMENT;
    ctx.fillText(fitText(ctx, row.title, titleW), rect.x, y);
  }
  if (placed.drop !== null) {
    // ONE PRESS, NO CONFIRMATION, and that is a judgement rather than an
    // oversight: a dropped item lands on the tile you are standing on and
    // `pickup` takes the top of that pile straight back, so the act is
    // reversible for the price of a turn. The irreversible thing near here is
    // walking away from it — ground items are deliberately not persisted — and
    // no button can warn about that.
    drawButton(ctx, placed.drop, DROP_LABEL, {
      ink: hoveredDrop ? PALETTE.GOLD : PALETTE.GREY_HI,
    });
  }
  y += ROW_H;

  ctx.font = FONT_BODY;
  ctx.fillStyle = PALETTE.GREY_HI;
  ctx.fillText(fitText(ctx, row.meta, rect.w), rect.x, y);
  y += ROW_H;

  if (row.desc !== '') {
    ctx.font = FONT_BODY;
    ctx.fillStyle = PALETTE.BONE;
    ctx.fillText(fitText(ctx, row.desc, rect.w), rect.x, y);
  }
  y += ROW_H;

  for (const line of row.rows) {
    const emphasis = line.emphasis === true;
    ctx.font = emphasis ? FONT_META : FONT_BODY;
    // `fitText` measures, so the font has to be live BEFORE it is called.
    const valueW = ctx.measureText(line.value).width;

    ctx.textAlign = 'left';
    ctx.fillStyle = emphasis ? PALETTE.GOLD : PALETTE.GREY_HI;
    ctx.fillText(fitText(ctx, line.label, rect.w - valueW - 6), rect.x, y);

    ctx.textAlign = 'right';
    ctx.fillStyle = emphasis ? PALETTE.GOLD : PALETTE.BONE;
    ctx.fillText(line.value, right, y);
    ctx.textAlign = 'left';
    y += ROW_H;
  }

  if (row.hiddenRows > 0) {
    ctx.font = FONT_BODY;
    ctx.fillStyle = PALETTE.GREY_HI;
    ctx.fillText(`${String(row.hiddenRows)} more not shown`, rect.x, y);
  }
}

/** One placed row. Every fill sets its own font immediately before it. */
function drawRow(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  placed: PlacedInventoryRow,
  focus: InventoryFocus | null,
  hovered: InventoryFocus | null,
  hoveredDrop: boolean,
): void {
  const { row, rect } = placed;

  switch (row.kind) {
    case InventoryRowKind.Tabs: {
      for (let i = 0; i < placed.tabs.length; i += 1) {
        const box = placed.tabs[i];
        const tab = TAB_ORDER[i];
        if (box === undefined || tab === undefined) continue;
        const selected = tab === row.tab;
        // THE COUNT IS ON THE TAB, which is how the bag says "five of twelve"
        // without a thirteenth cell existing to say it. BRACKETS mark the
        // selected tab as well as the colour does: never colour alone
        // (ui/partypanel.ts:78-92).
        const label =
          tab === InventoryTab.Equipped
            ? `EQUIPPED ${String(row.wornCount)}/${String(SLOT_ORDER.length)}`
            : `CARRIED ${String(row.carriedCount)}/${String(CARRIED_MAX)}`;
        drawButton(ctx, box, selected ? `[${label}]` : label, {
          ink: selected ? PALETTE.GOLD : PALETTE.GREY_HI,
        });
      }
      return;
    }

    case InventoryRowKind.Cells: {
      for (let i = 0; i < placed.cells.length; i += 1) {
        const box = placed.cells[i];
        const cell = row.cells[i];
        if (box === undefined || cell === undefined) continue;
        const self: InventoryFocus =
          cell.kind === 'item'
            ? { kind: 'item', itemId: cell.itemId }
            : { kind: 'slot', slot: cell.slot };
        drawCell(ctx, sprites, cell, box, sameFocus(focus, self), sameFocus(hovered, self));
      }
      return;
    }

    case InventoryRowKind.Note: {
      ctx.font = FONT_BODY;
      ctx.fillStyle = PALETTE.GREY_HI;
      ctx.fillText(fitText(ctx, row.text, rect.w), rect.x, rect.y + NOTE_ROW_H / 2);
      return;
    }

    case InventoryRowKind.Detail:
      drawDetail(ctx, placed, hoveredDrop);
      return;
  }
}

export type InventoryPanelDrawOptions = {
  readonly ctx: CanvasRenderingContext2D;
  readonly sprites: SpriteSource;
  readonly rect: PanelRect;
  /** From `inventoryPanelRows`. Passed in so the caller holds one copy per frame. */
  readonly rows: readonly InventoryRow[];
  /** Highlights the close control, so it reads as pressable. */
  readonly hoveredClose: boolean;
  /** What the strip is about — the last thing pointed at. Never cleared on leave. */
  readonly focus: InventoryFocus | null;
  /** What is under the pointer RIGHT NOW, or null. Cosmetic; clears on leave. */
  readonly hovered: InventoryFocus | null;
  /** Highlights the DROP control. */
  readonly hoveredDrop: boolean;
};

/**
 * Paint the panel.
 *
 * `save`/`restore` around everything because it sets `font`, `textAlign`,
 * `textBaseline` and `fillStyle`, none of which the world painter re-sets before
 * every call — a leak surfaces three milestones later as a mysteriously
 * right-aligned label somewhere else entirely. CLIPPED to its own rect for the
 * reason the card strip, the party pane and the sheet are: a long item name must
 * never bleed onto the map.
 *
 * IT DRAWS NO SCRIM. That is not an omission — it is the panel-not-modal
 * decision made visible. Everything behind it is still live and still pressable.
 */
export function drawInventoryPanel(options: InventoryPanelDrawOptions): void {
  const { ctx, sprites, rect, rows, hoveredClose, focus, hovered, hoveredDrop } = options;
  if (rect.w <= 0 || rect.h <= 0) return;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  drawPanel(ctx, sprites, PanelSkin.CaseFile, rect);
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();

  drawHeader(ctx, sprites, PANEL_TITLE, rect, FONT_META);

  const geometry = inventoryPanelGeometry(rect, rows);
  for (const placed of geometry.placed) {
    drawRow(ctx, sprites, placed, focus, hovered, hoveredDrop);
  }

  // The close control. The key that opened the panel closes it too and always
  // will — this is the mouse's copy of the same act.
  drawButton(ctx, geometry.close, '×', {
    ink: hoveredClose ? PALETTE.GOLD : PALETTE.GREY_HI,
  });

  ctx.restore();
}

/**
 * The panel's minimum height, for callers that need to reason about whether one
 * will fit before they ask for a rect. Exported for the test that pins the bottom
 * of the size range; nothing in production reads it.
 */
export const INVENTORY_PANEL_MIN_H = PANEL_MIN_H;
/** As above, for the width — which is also the panel's ONLY width. See the header. */
export const INVENTORY_PANEL_MIN_W = PANEL_MIN_W;
/** The air the panel leaves around itself inside its band. */
export const INVENTORY_PANEL_MARGIN = PANEL_MARGIN;
/** Three rows of four. Exported so the test does not spell the cap a second time. */
export const INVENTORY_PANEL_COLS = COLS;
export const INVENTORY_PANEL_CARRIED_MAX = CARRIED_MAX;
