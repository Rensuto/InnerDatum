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
 * THE EQUIPPED TAB IS A DOLL, NOT A LIST, AND THE ROW COUNT IS ARITHMETIC
 * ===========================================================================
 * The seven worn slots are PLACED on a 4x3 grid rather than run left to right in
 * reading order, because a paper doll's whole job is to say WHERE on a body a
 * thing goes. Upstream places every frame at an absolute x/y inside one doll
 * picture (EquipDoll.lua:171-212, from the table at load.lua:140-156) and blits
 * the actor into the middle of it (EquipDoll.lua:238). Ours:
 *
 *     r0:  OFFHAND  |     PORTRAIT      |  HEAD
 *     r1:  RING     |    (portrait)     |  BODY
 *     r2:  TRINKET  |  FEET  |    —     |  LEGS
 *
 * THE LEFT COLUMN IS HELD-AND-WORN TOKENS and the RIGHT COLUMN IS THE ARMOUR
 * SPINE, head to legs, which is upstream's own split: at load.lua:144-147 the
 * left column (x=48) carries OFFHAND, BODY and FINGER, while at load.lua:150-153
 * the right column (x=264) carries FEET, BELT, HANDS and CLOAK. FEET closes the
 * bottom row under the portrait because upstream's bottom row (y=408,
 * load.lua:147-149) is the one that closes the ring under the figure.
 *
 * DEVIATION, LABELLED: our HEAD sits at the TOP OF THE ARMOUR COLUMN rather than
 * top-centre over the portrait, which is where upstream puts it (load.lua:155,
 * `HEAD = {{weight=15, x=150, y=35, ...}}`). A three-row budget has no spare
 * top-centre row, and the reason it has only three rows is arithmetic rather
 * than taste — see `DOLL_ROWS`.
 *
 * ===========================================================================
 * NO SCROLLING, NO PAGING, AND THE CAP IS WHAT KEEPS THAT HONEST
 * ===========================================================================
 * ui/charsheet.ts:98-111 refuses scrolling in writing — "a scroll position is
 * state, state needs a scrollbar, a scrollbar needs a hit test" — and
 * ui/talents.ts:84-92 refuses it again. There is exactly ONE scrolling surface in
 * this whole client (the Case Log, and it scrolls by ENTRY INDEX with a text
 * signal rather than with a bar), and there is no scrollbar sprite in the
 * manifest.
 *
 * THIS FILE USED TO ADD "and there is no draggable control anywhere in ui/", AND
 * THAT IS NO LONGER TRUE — ui/drag.ts exists and this panel's header is a handle.
 * It does not weaken the refusal, it sharpens it. A drag that MOVES a window
 * carries no state between frames that anything else has to agree with: the
 * offset lives in one place, is clamped on read, and a panel nobody has touched
 * is at exactly the position `hudLayout` computed. A SCROLL POSITION is the
 * opposite — it is per-surface state that the painter, the hit test and the drop
 * policy must all read the same way, and it changes which cell is under a given
 * pixel. The one is a rect; the other is an index into content.
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
 * (`CarriedItemView.compare`, src/server/view/projector.ts:1328). This file does
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
 * THE COMPARISON STRIP'S HEIGHT IS RESERVED FROM THE RECT AND THE TAB, AND NEVER
 * FROM THE FOCUS. ═══ THE RULE IS ABOUT THE POINTER, NOT ABOUT THE TAB ═══ If the
 * strip's height depended on what was pointed at, the grid's remaining height
 * would shrink at that instant and the tail row would drop — so the cell under
 * the pointer could vanish BECAUSE it was pointed at, and pointing at the row
 * above would bring it back. That is the oscillation being forbidden, and
 * reserving from the rect is what stops it: nothing moves while the pointer does.
 *
 * THE TAB IS A DIFFERENT THING ENTIRELY and reserving per-tab costs nothing.
 * Switching tabs is a discrete click on a control that is not in the grid, the
 * panel RECT does not change with the tab (`inventoryPanelRect` never sees one),
 * and no cell is under the pointer at the moment of the switch by construction.
 * So the Equipped tab reserves ONE LINE and the Carried tab reserves `DETAIL_H`.
 * That is not a compromise, it is the honest size: `compare` exists only on
 * `CarriedItemView` (shared/protocol.ts:1390-1403) and `detailRow` hands a worn
 * item `rows: []`, so 84 pixels of strip on the doll would be reserved for
 * content that structurally cannot exist — and it is 84 pixels the doll needs.
 *
 * It draws into the BACKBUFFER at logical scale like every other ui/ module —
 * see the long note at the top of render/canvas.ts.
 */

import { ItemTier, SLOT_ORDER } from '../../shared/protocol.ts';
import { PALETTE } from '../render/canvas.ts';
import { DragKind, DraggablePanel } from './drag.ts';
import {
  drawButton,
  drawHeader,
  drawPanel,
  fitText,
  headerDragRect,
  HEADER_H,
  PANEL_PAD,
  PanelSkin,
} from './panel.ts';
import type {
  CarriedItemView,
  ShopMsg,
  InspectRow,
  InventoryMsg,
  ItemView,
  Slot,
} from '../../shared/protocol.ts';
import type { SpriteSource } from '../render/assets.ts';
import type { DragSubject } from './drag.ts';
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
 * The authored size of both cell plates, `ui_inventory_cell_empty` and
 * `ui_inventory_cell_hover`. 40x40, centred in the 64-pixel well.
 *
 * It is here ONLY so the primitives fallback can trace a box where the plate
 * would have been — `blitCentred` does the centring itself when the art is
 * present. A bare clone has no `client/public/assets/` at all, so the traced
 * plate is not an edge case, it is the state every fresh checkout runs in.
 */
const PLATE_PX = 40;

/**
 * How far above the bottom of the well an empty slot's caption is centred.
 *
 * `textBaseline` is `middle` for this whole file, so six puts a 10-pixel glyph in
 * the bottom twelve pixels of the 64-pixel well — the strip the 40x40 plate
 * leaves clear. See the caption note in `drawCell` for why it is inside the cell
 * at all rather than under it, which is where upstream puts its names.
 */
const CAPTION_BASELINE = 6;

/**
 * THE DOLL IS THREE ROWS AND THE COUNT IS ARITHMETIC, NOT TASTE.
 *
 * Measured against the smallest viewport this client will ever render at. The
 * logical backbuffer height is pinned to 480 by `minTilesH` in render/canvas.ts
 * (`tilesH = min(MAX_TILES_H, max(minTilesH, fitTilesH))`, canvas.ts:729-730), so
 * 480 is the floor rather than a comfortable case, and `panelBand` (main.ts:534-541)
 * gives back `height - HOTBAR_TOTAL_H - RESOURCE_H - LINE_H*2 - DOCK_MARGIN`:
 *
 *     480 - 88 - 18 - 28 - 3 = 343, band top ~17  ->  band 326
 *     the panel takes min(PANEL_MAX_H, 326 - 2*PANEL_MARGIN) = 314
 *     less HEADER_H 24 + INSET*2 16 + TAB_ROW_H 18 = 58  ->  256 for the grid
 *
 * (The 88 is `HOTBAR_TOTAL_H` and it is the SHRUNK bar — the row lost six pixels
 * when the player asked for a smaller one, so every figure on these lines is six
 * larger than it was. The conclusion below is unchanged, which is why it is worth
 * writing the arithmetic down rather than the answer.)
 *
 * THREE ROWS IS 3*72 + 2*5 = 226 — the trailing gap is omitted, because there is
 * nothing under the last row to be kept off — plus a ONE-LINE Equipped strip (12)
 * = 238, inside 256 with eighteen pixels of slack. FOUR ROWS IS 4*72 + 3*5 = 303,
 * which is 47 over, and the existing drop policy would resolve that silently by
 * shedding the tail row: the FEET slot would simply not be on the doll on the
 * most common small window, with one line of grey text to say so. So the doll is
 * three rows, and a fourth may not be added without moving the panel's whole
 * budget first.
 */
const DOLL_ROWS = 3;
/** Three cells tall with two gaps between them, and no trailing gap. */
const DOLL_H = DOLL_ROWS * CELL_PX + (DOLL_ROWS - 1) * CELL_GAP;

/** Where one worn slot sits on the doll's grid. Column and row, both 0-based. */
export type DollPlace = {
  readonly col: number;
  readonly row: number;
};

/**
 * THE DOLL'S PLACEMENT TABLE. Seven slots, seven boxes, and it is exhaustive over
 * `Slot` — a `Record`, so an eighth slot is a compile error here rather than a
 * cell that quietly never draws.
 *
 * LEFT COLUMN: what is held or hung on you. Upstream's left column (x=48) is
 * OFFHAND, BODY and FINGER (load.lua:144-147); ours is OFFHAND, RING and the
 * TRINKET that stands in for its TOOL slot (load.lua:149, `x=264, y=408`).
 * RIGHT COLUMN: the armour spine, head to legs, which is upstream's right column
 * (x=264) carrying CLOAK, HANDS, BELT and FEET top-to-bottom (load.lua:150-153).
 * FEET closes the bottom row under the portrait, as upstream's y=408 row closes
 * the ring under the figure (load.lua:147-149).
 *
 * DEVIATION, LABELLED: HEAD is at the top of the armour column, not top-centre
 * over the portrait where load.lua:155 puts it. See the header — a three-row
 * budget has no top-centre row to spend.
 */
const DOLL_PLACES: Readonly<Record<Slot, DollPlace>> = {
  offhand: { col: 0, row: 0 },
  ring: { col: 0, row: 1 },
  trinket: { col: 0, row: 2 },
  head: { col: 3, row: 0 },
  body: { col: 3, row: 1 },
  legs: { col: 3, row: 2 },
  feet: { col: 1, row: 2 },
};

/**
 * THE PORTRAIT'S REGION: columns 1-2 across rows 0-1, dead centre of the doll.
 *
 * ToME blits the ACTOR there — `self.actor:toScreen(nil, x + doll.doll_x, ...)`
 * at EquipDoll.lua:238, into the 128x128 hole `doll_x=116, doll_y=232` leaves in
 * the middle of the frame table (load.lua:140). We have no posed actor sprite, so
 * the class portrait already on the wire goes in its place; the point of it is
 * the same either way, which is that the slots read as places ON A BODY rather
 * than as a list of boxes.
 *
 * The bottom-middle cell (col 2, row 2) is deliberately EMPTY. Seven slots do not
 * divide into a rectangle, and a spare box that is not a slot must not look like
 * one — nothing is drawn there at all.
 */
const PORTRAIT_COL = 1;
const PORTRAIT_COLS = 2;
const PORTRAIT_ROWS = 2;

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

/**
 * THE EQUIPPED TAB'S STRIP: ONE LINE, and that is the honest size rather than a
 * concession to the doll.
 *
 * `compare` lives on `CarriedItemView` and on nothing else (shared/protocol.ts:
 * 1390-1403), and `detailRow` hands a worn item `rows: []`, so six of the seven
 * lines `DETAIL_H` reserves are for content the doll tab structurally cannot
 * produce. One line carries what it CAN produce: the name, and either the meta
 * (tier, slot, worn/empty) or the DROP control when the sticky focus is still on
 * a bag item the player looked at before switching tabs.
 *
 * See the header for why reserving per-TAB does not reintroduce the oscillation
 * that reserving per-FOCUS would.
 */
const DETAIL_COMPACT_H = ROW_H;

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
 *
 * IT IS THE BAG'S SHAPE THAT SETS THE MAXIMUM, and that stays true now the doll
 * is placed rather than flat: three cell rows plus the seven-line strip is
 * 231 + 84, against the doll's 226 plus a one-line strip. So the panel is never
 * SHORTER than the doll needs and the rect does not change with the tab — which
 * is the property `inventoryPanelRect` never taking a tab is there to guarantee,
 * because a panel that resized on a tab switch would have moved out from under
 * the click that switched it.
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
 * The purse, on the header strip beside the title.
 *
 * ═══ WHY HERE AND NOT IN A ROW OF ITS OWN ═══
 * A row would need geometry, a hit region and a place in the tab order, and it
 * would push the grid down by its own height on the smallest window this panel
 * is allowed to be — where `inventoryPanelRows` is already fighting for the
 * tail row. The header strip is drawn on every frame the panel is open, is
 * never scrolled, and is the first thing the eye lands on.
 *
 * IT IS PART OF THE TITLE STRING rather than a second `fillText`, so it inherits
 * the strip's own clipping and truncation for free: a four-digit purse on a
 * narrow panel loses characters off the end like any other long title, instead
 * of drawing over the close control.
 */
function panelTitle(money: number, shop?: { name: string; count: number } | null): string {
  const purse = !Number.isFinite(money) || money <= 0 ? '' : `  ${String(Math.floor(money))} GOLD`;
  // THE SHOP LAST, so the purse sits next to the title where a player already
  // looks for it and the room's name reads as context rather than as a heading.
  const here =
    shop === null || shop === undefined
      ? ''
      : `  ·  ${shop.name.toUpperCase()} (${String(shop.count)})`;
  return `${PANEL_TITLE}${purse}${here}`;
}

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

/**
 * The control's ink.
 *
 * GOLD FOR BUY EVEN UNHOVERED, because it is the one control on this panel that
 * spends something — and the palette already reserves GOLD for "this is the
 * thing worth looking at". A disabled control goes flat grey rather than
 * disappearing, so the strip's layout does not move under the pointer.
 */
function buttonInk(action: DetailAction, hovered: boolean): string {
  if (!action.enabled) return PALETTE.GREY;
  if (hovered) return PALETTE.GOLD;
  return action.kind === 'buy' ? PALETTE.GOLD : PALETTE.GREY_HI;
}

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
  /**
   * THE SHELF, AND ONLY WHEN YOU ARE STANDING IN A ROOM THAT HAS ONE.
   *
   * A TAB RATHER THAN A SECOND PANEL, deliberately. ToME's shop is a
   * two-column dialog — their goods left, yours right — because it has no other
   * way to answer "is this better than what I have". This panel already answers
   * that: hovering anything fills the comparison strip with a delta against the
   * doll you are wearing. So a tab reuses the cells, the hover-compare, the
   * drag and the close control, and the one thing a second panel would have
   * bought is a thing we already have.
   */
  Shop: 'shop',
} as const;
export type InventoryTab = (typeof InventoryTab)[keyof typeof InventoryTab];

/** Left to right, which is also the order the hit test answers in. */
const TAB_ORDER: readonly InventoryTab[] = [InventoryTab.Equipped, InventoryTab.Carried];

/**
 * The tabs on screen right now.
 *
 * THE SHOP TAB EXISTS ONLY WHERE A SHOP DOES. A greyed third tab in every room
 * would be a permanent advertisement for something most rooms do not have, and
 * a player who pressed it once in a corridor would learn to stop looking at it
 * — which is exactly the wrong lesson for the one tab that has gold in it.
 *
 * A FUNCTION AND NOT A CONSTANT, so the hit test and the painter cannot
 * disagree about how many boxes there are. Both call this.
 */
export function tabsFor(hasShop: boolean): readonly InventoryTab[] {
  return hasShop ? [...TAB_ORDER, InventoryTab.Shop] : TAB_ORDER;
}

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
      /**
       * WHAT IT COSTS, on the shop tab only. Null everywhere else.
       *
       * THE SERVER'S NUMBER, off `ShopItemView.buy`, never derived here — see
       * that type: a client that computed its own prices would be a second copy
       * of the economy, and the first thing to drift would be the spread that
       * stops a shop being farmable.
       */
      readonly price?: number | null;
      /**
       * FALSE WHEN THE VIEWER CANNOT AFFORD IT. Cosmetic — the server refuses
       * the purchase either way — but a shelf that looks identical whether or
       * not you can buy from it makes a player click to find out, and a refusal
       * is a worse answer than a greyed price.
       */
      readonly affordable?: boolean;
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

/**
 * WHAT THE STRIP'S BUTTON DOES, when it has one.
 *
 * ONE BUTTON, THREE MEANINGS, AND THE ROW DECIDES WHICH. It was `dropId: string
 * | null` while DROP was the only thing a strip could offer. A shop makes that
 * three: you drop a thing you are carrying, you sell it if there is somebody
 * here to sell it to, and you buy what is on the shelf. Keeping one control and
 * naming what it means is what stops the strip growing a row of buttons that
 * are mostly disabled.
 */
export type DetailAction = {
  readonly kind: 'drop' | 'buy' | 'sell';
  /** What the verb will name. */
  readonly itemId: string;
  /** The word on the button, already including the price where there is one. */
  readonly label: string;
  /**
   * FALSE GREYS IT AND THE HIT TEST STILL ANSWERS. A control that vanished when
   * you could not afford it would move the strip's layout under the pointer.
   */
  readonly enabled: boolean;
};

export const InventoryRowKind = {
  /** The `[EQUIPPED]` / `[CARRIED]` pair. Always the first row. */
  Tabs: 'tabs',
  /** Up to four cells, left to right. The BAG's shape. */
  Cells: 'cells',
  /**
   * THE PAPER DOLL: seven cells PLACED on a 4x3 grid, plus the portrait.
   *
   * A separate kind rather than three `Cells` rows because a doll cell carries
   * its own `(col, row)` and is NOT laid out flat at `row.x + i * pitch` the way
   * `cellRects` lays a bag row out. Three `Cells` rows could not express the
   * portrait spanning two columns and two rows, nor the deliberately empty box
   * at the bottom middle — it would have to be a fake cell, which is exactly the
   * "a gap that looks like a slot" this whole tab exists to stop.
   */
  Doll: 'doll',
  /** The comparison strip. Always the last row; its height depends on the TAB. */
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
      /**
       * WHICH TABS EXIST, left to right. Two in most rooms, three where there is
       * a shop — carried on the ROW so the painter and the hit test read one
       * list. Deriving it twice is how a box appears that can be clicked and not
       * seen, or seen and not clicked.
       */
      readonly tabs: readonly InventoryTab[];
      /** How many things are on the shelf. Zero when there is no shop. */
      readonly shopCount: number;
    }
  | { readonly kind: typeof InventoryRowKind.Cells; readonly cells: readonly InventoryCell[] }
  | {
      readonly kind: typeof InventoryRowKind.Doll;
      /**
       * All seven, in `SLOT_ORDER`. PARALLEL TO `places`, index for index — the
       * hit test and the painter both walk the two together, so a doll that
       * placed its cells in a different order from the one it lists them in
       * would answer with the slot beside the one that was clicked.
       */
      readonly cells: readonly InventoryCell[];
      readonly places: readonly DollPlace[];
      /**
       * The viewer's own class portrait — an `icon_character_the_*` key off the
       * wire — or null, which is the state before anything has said which class
       * this is. Never assembled from a class name here; see `frameIdFor`.
       */
      readonly portrait: string | null;
      /**
       * THE ONE SLOT A LIVE DRAG COULD BE RELEASED INTO, or null when nothing is
       * being dragged. It is a single slot rather than a set because an item's
       * destination is authored content — `CarriedItemView.slot` — so there is
       * exactly one place a given item can go, filled or not.
       */
      readonly dropSlot: Slot | null;
    }
  | {
      readonly kind: typeof InventoryRowKind.Detail;
      /**
       * ONE LINE INSTEAD OF SEVEN. True on the Equipped tab, where the wire
       * cannot produce comparison rows at all. See `DETAIL_COMPACT_H`.
       */
      readonly compact: boolean;
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
      readonly action: DetailAction | null;
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
  /**
   * THE SHELF OF THE ROOM YOU ARE IN, or null for a room with no shop.
   *
   * NULL IS THE WHOLE SIGNAL, all the way from the server: a `shop` frame is
   * sent only for a realm that has one, so there is no second "is there a shop
   * here" flag free to disagree with the shelf itself.
   */
  readonly shop?: ShopMsg | null;
  readonly tab: InventoryTab;
  /** The strip's subject. See `InventoryFocus` — the caller must not clear it. */
  readonly focus: InventoryFocus | null;
  /**
   * THE VIEWER'S OWN CLASS PORTRAIT, for the middle of the doll.
   *
   * An `icon_character_the_*` asset KEY, exactly as `TurnActor.portrait`
   * (shared/protocol.ts:3229) and `PartyStateMember.portrait` (:2890) carry it —
   * the server picks it from the class in src/server/view/projector.ts:387-393
   * and this file never derives one, because a key built in a browser resolves to
   * the loud violet missing-asset box on every clone.
   *
   * OPTIONAL, AND THE OMISSION IS A LEGIBLE STATE RATHER THAN A HOLE: with no id
   * the portrait region draws a primitives silhouette, which is also what a bare
   * clone with no art at all sees. It is optional because `InventoryMsg` does not
   * carry a portrait — the caller has to join it from the `turn` or `party_state`
   * frame it already holds — and a required field would mean this panel could not
   * be built at all before the first of those arrived.
   */
  readonly portrait?: string | null;
  /**
   * WHAT THE POINTER IS CARRYING, or null. Cosmetic ONLY: it decides which doll
   * cell wears `ui_inventory_cell_hover`, and nothing else.
   *
   * IT IS NOT WHERE A DROP IS RESOLVED. A release over the doll is read back
   * through the ordinary hit test — `EmptySlot { slot }` or `Item { slot, worn }`
   * — because that is the same answer a click gives and a second code path for
   * "the pointer was down when it got here" is a second copy of the geometry.
   */
  readonly drag?: DragSubject | null;
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

/**
 * The shelf, as cells.
 *
 * `affordable` is computed HERE and not on the wire: it is a comparison between
 * two numbers the client already holds (the shelf's price and the purse off the
 * inventory frame), and putting it on the wire would have meant a broadcast
 * carrying one player's balance to the whole room.
 */
function shopCells(shop: ShopMsg, money: number): readonly InventoryCell[] {
  return shop.stock.slice(0, CARRIED_MAX).map((row): InventoryCell => ({
    kind: 'item',
    itemId: row.itemId,
    name: row.name,
    icon: row.icon,
    tier: row.tier,
    // THE SHELF HAS NO SLOT COLUMN — `ShopItemView` deliberately omits it,
    // because what a coat is worn on is a fact about the coat and the strip
    // reads it off the resolved item. `body` is a placeholder the grid never
    // shows; the strip prints the real one.
    slot: 'body',
    worn: false,
    price: row.buy,
    affordable: money >= row.buy,
  }));
}

/**
 * WHERE A LIVE DRAG COULD LAND ON THE DOLL, or null.
 *
 * CARRIED ONLY. A worn item dragged OFF the doll has no destination on the doll —
 * its destination is the bag, the floor or a hotbar slot, none of which are
 * drawn here — so highlighting the slot it came from would be a drop target that
 * does nothing, which is worse than none at all.
 *
 * ═══ HOW A *CARRIED* DRAG IS EVER LIVE WHILE THE *EQUIPPED* TAB IS UP ═══
 * Worth saying out loud, because the two collections are on mutually exclusive
 * tabs and the obvious reading is that this can never fire. The caller springs
 * the tab mid-gesture: an item drag held over the other tab switches to it
 * (main.ts's `springInventoryTab`), which is what puts the doll on screen with
 * something still in the player's hand. Without that this function, the
 * `ui_inventory_cell_hover` swap below and both inventory branches of the
 * caller's `resolveDrop` are all unreachable — which is what they were.
 *
 * The slot is the item's OWN, off the wire (`CarriedItemView.slot`), never
 * guessed from its name or its icon: what a thing can be worn as is authored
 * content in src/server/content/items.ts and the server is the only reader of it.
 */
function dropSlotFor(inventory: InventoryMsg, drag: DragSubject | null | undefined): Slot | null {
  if (drag === null || drag === undefined || drag.kind !== DragKind.Carried) return null;
  const item = inventory.carried.find((entry) => entry.itemId === drag.itemId);
  return item === undefined ? null : item.slot;
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
/**
 * The SELL control for a carried item, or null when there is nobody to sell to.
 *
 * The price is the server's, off the shelf frame — but a thing in your bag is
 * not necessarily on the shelf, so this asks the frame for the shop's own
 * quote. When the shop has never quoted this item the control is offered
 * anyway, unpriced: the server prices it on arrival and refuses what it will
 * not take, and a missing label is better than a client inventing a number.
 */
function sellAction(view: InventoryPanelView, itemId: string): DetailAction | null {
  const shop = view.shop;
  if (shop == null) return null;
  const quoted = shop.stock.find((row) => row.itemId === itemId);
  return {
    kind: 'sell',
    itemId,
    label: quoted === undefined ? 'SELL' : `SELL ${String(quoted.sell)}`,
    enabled: true,
  };
}

/**
 * The carried view of a shelved item, when the player happens to own one.
 *
 * WHY THIS IS NOT ALWAYS AVAILABLE: `CarriedItemView.compare` is computed by
 * the server against the RECIPIENT'S doll, so it exists only for things in
 * their bag. A coat on the shelf that the player does not own has no compare
 * rows yet — the strip prints the description and the price, and the comparison
 * arrives the moment they buy it. Inventing one here would mean a second copy
 * of the arithmetic, in the browser, against a sheet the client only partly
 * knows.
 */
function itemOnShelf(view: InventoryPanelView, itemId: string): CarriedItemView | undefined {
  return view.inventory?.carried.find((row) => row.itemId === itemId);
}

function detailRow(view: InventoryPanelView, inventory: InventoryMsg | null): InventoryRow {
  // THE HEIGHT IS THE TAB'S AND NEVER THE FOCUS'S. See `DETAIL_COMPACT_H` and the
  // header: a strip that grew when a cell was pointed at would drop the tail row
  // of the grid at that instant, so the cell under the pointer could vanish
  // because it was pointed at.
  const compact = view.tab === InventoryTab.Equipped;

  const blank = {
    kind: InventoryRowKind.Detail,
    compact,
    title: '',
    meta: DETAIL_HINT,
    desc: '',
    rows: [] as readonly InspectRow[],
    hiddenRows: 0,
    action: null,
  } as const;

  const focus = view.focus;
  if (focus === null || inventory === null) return blank;

  if (focus.kind === 'slot') {
    // An empty slot is worth a line: it is where the player learns that `offhand`
    // and `trinket` are places things can go. The doll's own captions now say the
    // same seven words in the cells (see `drawCell`), and the two agreeing is the
    // point — the caption is what a player reads at a glance, the strip is what
    // they read when they have pointed at one on purpose.
    return {
      kind: InventoryRowKind.Detail,
      compact,
      title: focus.slot,
      meta: 'empty',
      desc: '',
      rows: [],
      hiddenRows: 0,
      action: null,
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
      compact,
      title: carried.name,
      meta: `${tierWord(carried.tier)} · ${carried.slot}`,
      desc: carried.desc,
      rows: capped ? all.slice(0, DETAIL_ROWS_MAX - 1) : all,
      hiddenRows: capped ? all.length - (DETAIL_ROWS_MAX - 1) : 0,
      // DROP IS OFFERED FOR A CARRIED ITEM ONLY. ToME's `playerDrop`
      // (Game.lua:2173-2176 -> `DROP_FLOOR`) drops out of INVEN, and taking a
      // worn thing off is a separate act there and here.
      //
      // ═══ AND IT BECOMES SELL WHERE THERE IS SOMEBODY TO SELL TO ═══
      // One control, because the two acts are alternatives rather than
      // companions: nobody standing in a shop wants to throw a coat on the
      // floor when the shop will pay for it. Outside a shop there is nobody to
      // pay, so DROP is the only honest offer.
      action: sellAction(view, carried.itemId) ?? {
        kind: 'drop',
        itemId: carried.itemId,
        label: DROP_LABEL,
        enabled: true,
      },
    };
  }

  for (const slot of SLOT_ORDER) {
    const worn = inventory.equipped[slot];
    if (worn === undefined || worn.itemId !== focus.itemId) continue;
    return {
      kind: InventoryRowKind.Detail,
      compact,
      title: worn.name,
      meta: `${tierWord(worn.tier)} · ${slot} · worn`,
      desc: worn.desc,
      rows: [],
      hiddenRows: 0,
      // NO CONTROL ON A WORN ITEM, in a shop or out of one. Selling the coat off
      // your own back is one click from being an accident, and taking it off is
      // already a separate act.
      action: null,
    };
  }

  // ═══ THE SHELF ═══
  const shelved = view.shop?.stock.find((row) => row.itemId === focus.itemId);
  if (shelved !== undefined) {
    const item = itemOnShelf(view, shelved.itemId);
    const money = inventory.money;
    return {
      kind: InventoryRowKind.Detail,
      compact,
      title: shelved.name,
      meta: `${tierWord(shelved.tier)} · ${String(shelved.buy)} gold · sells back for ${String(shelved.sell)}`,
      desc: item?.desc ?? '',
      // THE SAME COMPARISON A CARRIED ITEM GETS, which is the whole reason this
      // is a tab on this panel rather than a shop dialog of its own: the
      // question at a shop is never "what is this", it is "is it better than
      // what I am wearing", and this strip already answers that.
      rows: item?.compare ?? [],
      hiddenRows: 0,
      action: {
        kind: 'buy',
        itemId: shelved.itemId,
        label: `BUY ${String(shelved.buy)}`,
        // GREYED, NOT HIDDEN. A control that vanished when you could not afford
        // it would move the strip's layout under the pointer.
        enabled: money >= shelved.buy,
      },
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
 * (src/server/content/items.ts); the bag is in the order the frame carries, which
 * is the order things were picked up in. Sorting either — by tier, by name —
 * would mean the cell under a player's finger moved because a number changed
 * somewhere else.
 *
 * THE DOLL'S LIST ORDER AND ITS PLACEMENT ARE TWO SEPARATE FACTS ABOUT THE SAME
 * SEVEN THINGS, and keeping them separate is deliberate. `SLOT_ORDER` no longer
 * doubles as the reading order — `DOLL_PLACES` decides where each slot is drawn —
 * so a later pass that wants to move BODY above HEAD edits the placement table
 * and touches neither the wire's order nor the server's fold. The two arrays stay
 * index-parallel, which is what the hit test and the painter both depend on.
 */
export function inventoryPanelRows(view: InventoryPanelView): readonly InventoryRow[] {
  const inventory = view.inventory;
  const rows: InventoryRow[] = [
    {
      kind: InventoryRowKind.Tabs,
      tab: view.tab,
      wornCount: inventory === null ? 0 : Object.keys(inventory.equipped).length,
      carriedCount: inventory === null ? 0 : inventory.carried.length,
      // ON THE ROW rather than derived twice. The painter draws these boxes and
      // the hit test names them, and a third tab that existed for one of them
      // would be a box you could click and not see, or see and not click.
      tabs: tabsFor(view.shop != null),
      shopCount: view.shop?.stock.length ?? 0,
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

  if (view.tab === InventoryTab.Shop && view.shop != null) {
    const cells = shopCells(view.shop, view.inventory?.money ?? 0);
    rows.push(...intoRows(cells));
    if (cells.length === 0) {
      // A SHOP CAN BE EMPTY and it is worth saying so plainly: the shelves top
      // up when somebody levels, so "come back" is the actual answer.
      rows.push({ kind: InventoryRowKind.Note, text: 'the shelves are bare — come back later' });
    }
  } else if (view.tab === InventoryTab.Equipped) {
    // ONE ROW, NOT THREE. The doll is a placed grid — see `InventoryRowKind.Doll`
    // — and `equippedCells` still hands over all seven in `SLOT_ORDER`, so
    // `cells` and `places` stay parallel and the doll's LIST order and its
    // PLACEMENT are two facts about the same seven things rather than two lists.
    const cells = equippedCells(inventory);
    rows.push({
      kind: InventoryRowKind.Doll,
      cells,
      places: cells.map((cell) => DOLL_PLACES[cell.slot]),
      portrait: view.portrait ?? null,
      dropSlot: dropSlotFor(inventory, view.drag),
    });
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
    case InventoryRowKind.Doll:
      return DOLL_H;
    case InventoryRowKind.Detail:
      return row.compact ? DETAIL_COMPACT_H : DETAIL_H;
    case InventoryRowKind.Note:
      return NOTE_ROW_H;
  }
}

/** One row, placed, with whatever controls it carries. */
export type PlacedInventoryRow = {
  readonly row: InventoryRow;
  readonly rect: PanelRect;
  /**
   * Cell boxes in the ROW'S OWN ORDER, index for index. Empty for every row but
   * `Cells` and `Doll`.
   *
   * ═══ A DOLL CELL THAT DID NOT FIT KEEPS ITS INDEX AND GETS A ZERO-SIZED BOX ═══
   * The alternative — a shorter array — would break the one property the hit test
   * depends on, which is that `placed.cells[i]` and `row.cells[i]` are the same
   * cell. A zero-width box fails `px >= x && px < x + w` for every point, so it is
   * unhittable by construction rather than by a guard somebody can forget, and the
   * painter skips it for the same reason `drawButton` refuses a zero-width rect.
   */
  readonly cells: readonly PanelRect[];
  /** The two tab boxes, in `TAB_ORDER`. Empty for every row but `Tabs`. */
  readonly tabs: readonly PanelRect[];
  /** The strip's DROP control, or null when there is nothing to drop. */
  readonly drop: PanelRect | null;
  /**
   * The doll's portrait region, or null. NOT a cell and never hit tested: it is
   * upstream's actor blit (EquipDoll.lua:238), which is a picture of you rather
   * than a place to put something.
   */
  readonly portrait: PanelRect | null;
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

/** The top-left corner of one 4x3 doll box, from its grid coordinates. */
function dollCellRect(row: PanelRect, place: DollPlace): PanelRect {
  return {
    x: row.x + place.col * (CELL_PX + CELL_GAP),
    y: row.y + place.row * (CELL_PX + CELL_GAP),
    w: CELL_PX,
    h: CELL_PX,
  };
}

/**
 * How many of the doll's three grid rows fit in `avail` pixels.
 *
 * WHOLE ROWS ONLY, AND FROM THE TOP. Half a cell would still look pressable, and
 * shedding from the middle would silently reorder the doll. The last row placed
 * has no trailing gap, which is the same arithmetic `DOLL_H` states.
 */
function dollRowsThatFit(avail: number): number {
  let fit = 0;
  for (let n = 1; n <= DOLL_ROWS; n += 1) {
    if (n * CELL_PX + (n - 1) * CELL_GAP > avail) break;
    fit = n;
  }
  return fit;
}

/**
 * The tab boxes. Positional, so a click names a tab without reading state.
 *
 * WIDTH IS DIVIDED BY HOW MANY THERE ARE, so the third tab does not overflow the
 * panel when a shop appears — the panel has exactly one width (see the header),
 * and three boxes in a two-box strip would have run the last one off the edge.
 */
function tabRects(row: PanelRect, count: number): readonly PanelRect[] {
  const n = Math.max(1, count);
  const w = Math.floor((row.w - TAB_GAP * (n - 1)) / n);
  return Array.from({ length: n }, (_unused, index) => ({
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
  // THE STRIP'S HEIGHT IS THE TAB'S — one line on the doll, seven in the bag. It
  // comes off the ROW rather than off a constant so there is one authority for
  // it, and `rowHeight` is that authority.
  const stripH = detail === undefined ? 0 : rowHeight(detail);
  // ROOM FOR THE STRIP MEANS ROOM FOR THE STRIP AND ONE ROW OF CELLS. A panel
  // that spent its whole height on a comparison of an item it could no longer
  // show would be a comparison with nothing to compare.
  const room = bottom - top - TAB_ROW_H;
  const stripped = detail !== undefined && room >= CELL_ROW_H + stripH;
  const limit = stripped ? bottom - stripH : bottom;

  const placed: PlacedInventoryRow[] = [];
  let cursor = top;
  let droppedCells = 0;

  for (const row of rows) {
    if (row.kind === InventoryRowKind.Detail) continue;

    if (row.kind === InventoryRowKind.Doll) {
      // THE DOLL SHEDS GRID ROWS FROM THE TAIL, exactly as the bag sheds cell
      // rows, and says how many slots went. Unreachable at any viewport this
      // client renders — see `DOLL_ROWS`, where the budget is worked out against
      // the 480-pixel floor — but a rect can be handed to this function by
      // anything, and a doll silently missing three slots is precisely the "a gap,
      // not a slot" failure the tab exists to prevent.
      const fit = dollRowsThatFit(limit - cursor);
      if (fit === 0) {
        droppedCells += row.cells.length;
        continue;
      }
      const h = fit * CELL_PX + (fit - 1) * CELL_GAP;
      const rowRect: PanelRect = { x, y: cursor, w: innerW, h };
      const boxes = row.places.map((place) =>
        place.row < fit ? dollCellRect(rowRect, place) : { x: rowRect.x, y: rowRect.y, w: 0, h: 0 },
      );
      droppedCells += boxes.filter((box) => box.w === 0).length;
      // The portrait spans rows 0-1, so it takes whichever of those two survived.
      const portraitRows = Math.min(fit, PORTRAIT_ROWS);
      placed.push({
        row,
        rect: rowRect,
        cells: boxes,
        tabs: [],
        drop: null,
        portrait: {
          x: rowRect.x + PORTRAIT_COL * (CELL_PX + CELL_GAP),
          y: rowRect.y,
          w: PORTRAIT_COLS * CELL_PX + (PORTRAIT_COLS - 1) * CELL_GAP,
          h: portraitRows * CELL_PX + (portraitRows - 1) * CELL_GAP,
        },
      });
      cursor += h;
      continue;
    }

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
      tabs: row.kind === InventoryRowKind.Tabs ? tabRects(rowRect, row.tabs.length) : [],
      drop: null,
      portrait: null,
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
      portrait: null,
    });
    cursor += NOTE_ROW_H;
  }

  // The strip LAST and at the bottom of the panel, so it holds still while the
  // grid above it grows and shrinks. ToME puts its description zone beside the
  // list rather than under it (ShowInventory.lua:37, :56-60) because an 800-pixel
  // dialog can afford two columns; at 320 the only free edge is the bottom one.
  if (detail !== undefined && stripped) {
    const stripRect: PanelRect = { x, y: bottom - stripH, w: innerW, h: stripH };
    placed.push({
      row: detail,
      rect: stripRect,
      cells: [],
      tabs: [],
      drop:
        detail.kind === InventoryRowKind.Detail && detail.action !== null
          ? {
              x: stripRect.x + stripRect.w - DROP_W,
              y: stripRect.y,
              w: DROP_W,
              h: DROP_H,
            }
          : null,
      portrait: null,
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
  /** The strip's BUY control, on the shop tab. `enabled` says if it is affordable. */
  Buy: 'buy',
  /** The strip's SELL control — a carried item, in a room with a shop. */
  Sell: 'sell',
  /**
   * The header strip, minus the close control — the DRAG HANDLE.
   *
   * A PRESS-TIME outcome. See `InventoryDrag` for why the two new members are in
   * this vocabulary but not in `InventoryHit`.
   */
  Header: 'header',
  /** A cell that holds something, at the moment a press on it becomes a gesture. */
  DragStart: 'drag_start',
} as const;
export type InventoryHitKind = (typeof InventoryHitKind)[keyof typeof InventoryHitKind];

/**
 * WHAT A CLICK AT A POINT MEANS. Five outcomes, and the set is closed.
 *
 * `Header` and `DragStart` are deliberately NOT here even though they share the
 * `InventoryHitKind` vocabulary — see `InventoryDrag`.
 */
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
  | {
      /**
       * THE STRIP'S ONE CONTROL, whichever of the three it currently is.
       *
       * `enabled` travels with the hit rather than being re-derived by the
       * caller: the hit test already knows, and a second copy of "can they
       * afford it" in main.ts is a second copy free to disagree with the ink
       * the player is looking at.
       */
      readonly kind:
        typeof InventoryHitKind.Drop | typeof InventoryHitKind.Buy | typeof InventoryHitKind.Sell;
      readonly itemId: string;
      readonly enabled: boolean;
    };

/**
 * WHAT A PRESS AT A POINT WOULD PICK UP. Two outcomes, and a separate type.
 *
 * ═══ WHY A PRESS AND A CLICK ARE TWO QUESTIONS ═══
 * They are different acts on the same pixel. Clicking a bag cell equips what is
 * in it; pressing the same cell and moving six pixels picks it up to put
 * somewhere else (ui/drag.ts's `DRAG_THRESHOLD_PX`, Mouse.lua:177). A single
 * function returning one answer would force the caller to guess which act the
 * player meant, and the guess would be wrong exactly half the time.
 *
 * ═══ AND WHY THEY ARE TWO TYPES RATHER THAN ONE WIDER UNION ═══
 * `InventoryHit` is consumed by an EXHAUSTIVE `switch` in main.ts — eslint's
 * `switch-exhaustiveness-check` is on — so a sixth member of that union is a
 * compile error in a file this panel does not own, for an outcome the click path
 * has nothing to do with. Splitting the types keeps the click switch complete and
 * total, and it says the true thing: a press is not a click with an extra case.
 *
 * BOTH READ `inventoryPanelGeometry`. There is still exactly ONE copy of where
 * anything is, which is the property ui/partypanel.ts:93-99 records the cost of
 * losing — a control that answers a row above where it was drawn, on somebody
 * else's window size only.
 */
export type InventoryDrag =
  | { readonly kind: typeof InventoryHitKind.Header }
  | {
      readonly kind: typeof InventoryHitKind.DragStart;
      /**
       * WHAT WOULD BE PICKED UP, in ui/drag.ts's own vocabulary rather than in a
       * shape invented here — a bag item is named by `itemId` because equipping it
       * sends `equip { itemId }`, a worn item by its `Slot` because removing it
       * sends `unequip { slot }` (shared/protocol.ts:1949 takes `z.enum(SLOT_ORDER)`).
       */
      readonly subject: DragSubject;
    };

/**
 * The header strip's grabbable part. ONE copy of the reservation arithmetic.
 *
 * `PANEL_PAD + CLOSE_PX` is this panel's own close control, and it stays private
 * here: ui/panel.ts's `headerDragRect` deliberately does not know any panel's
 * `CLOSE_PX` (see its note), because a second authority on where a close control
 * lives is the exact duplication it exists to prevent.
 */
function headerHandle(rect: PanelRect): PanelRect {
  return headerDragRect(rect, PANEL_PAD + CLOSE_PX);
}

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
      if (row.kind === InventoryRowKind.Detail && row.action !== null) {
        // THE HIT ANSWERS EVEN WHEN THE CONTROL IS GREYED. The caller decides
        // what a disabled press means — today it says why, which is a better
        // answer than a click that does nothing at all.
        return {
          kind:
            row.action.kind === 'buy'
              ? InventoryHitKind.Buy
              : row.action.kind === 'sell'
                ? InventoryHitKind.Sell
                : InventoryHitKind.Drop,
          itemId: row.action.itemId,
          enabled: row.action.enabled,
        };
      }
    }

    for (let i = 0; i < placed.tabs.length; i += 1) {
      const box = placed.tabs[i];
      const tab = placed.row.kind === InventoryRowKind.Tabs ? placed.row.tabs[i] : undefined;
      if (box === undefined || tab === undefined || !inside(box)) continue;
      return { kind: InventoryHitKind.Tab, tab };
    }

    // BOTH GRID KINDS, one loop. The bag is laid out flat and the doll is placed,
    // but `placed.cells[i]` names `row.cells[i]` either way — that parallel is the
    // whole contract, and it is why a shed doll cell keeps its index and takes a
    // zero-sized box rather than being spliced out.
    const row = placed.row;
    if (row.kind !== InventoryRowKind.Cells && row.kind !== InventoryRowKind.Doll) continue;
    for (let i = 0; i < placed.cells.length; i += 1) {
      const box = placed.cells[i];
      const cell = row.cells[i];
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
 * WHAT A PRESS AT THIS POINT WOULD PICK UP — the header, an item, or nothing.
 *
 * See `InventoryDrag` for why this is a second reader over one geometry rather
 * than a sixth branch of `inventoryPanelHitAt`.
 *
 * AN EMPTY DOLL CELL IS NOT A DRAG SOURCE. There is nothing in it to pick up, and
 * a gesture that started on one would be a drag carrying nothing — which either
 * does nothing on release (a control that does nothing) or, worse, invents a
 * subject. It is still a perfectly good drop TARGET, and that is not a
 * contradiction: you can put a boot in an empty slot and you cannot take one out.
 *
 * The close control is refused explicitly rather than left to `headerDragRect`'s
 * reservation: pressing × and moving the mouse two pixels must close the panel,
 * not move it. A panel narrower than its own controls gets a zero-width handle,
 * and without this line that case would become "the close button drags the
 * window".
 */
export function inventoryPanelDragAt(
  rect: PanelRect,
  rows: readonly InventoryRow[],
  px: number,
  py: number,
): InventoryDrag | null {
  const inside = (r: PanelRect): boolean =>
    px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;

  if (inside(closeRect(rect))) return null;
  if (inside(headerHandle(rect))) return { kind: InventoryHitKind.Header };

  for (const placed of inventoryPanelGeometry(rect, rows).placed) {
    const row = placed.row;
    if (row.kind !== InventoryRowKind.Cells && row.kind !== InventoryRowKind.Doll) continue;
    for (let i = 0; i < placed.cells.length; i += 1) {
      const box = placed.cells[i];
      const cell = row.cells[i];
      if (box === undefined || cell === undefined || !inside(box)) continue;
      if (cell.kind === 'empty') return null;
      return {
        kind: InventoryHitKind.DragStart,
        subject: cell.worn
          ? { kind: DragKind.Worn, slot: cell.slot }
          : { kind: DragKind.Carried, itemId: cell.itemId },
      };
    }
  }
  return null;
}

/**
 * The panel this file's header handle belongs to, so the caller does not spell
 * `'inventory'` a second time and cannot spell it wrong.
 *
 * It is a re-export of ui/drag.ts's member rather than a string: `DraggablePanel`
 * is the closed set the offset store is keyed by, and a literal here would be a
 * key that type-checks against `Record<DraggablePanel, …>` only by luck.
 */
export const INVENTORY_DRAG_PANEL: DraggablePanel = DraggablePanel.Inventory;

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
  /** True when a live drag could be released here. See `dropSlotFor`. */
  dropTarget: boolean,
): void {
  // A SHED DOLL CELL. It keeps its index in the array so the hit test stays
  // parallel; it has no box, so there is nothing to paint. See `PlacedInventoryRow`.
  if (box.w <= 0 || box.h <= 0) return;

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
    // have no silhouettes cut for them — hence the caption below.
    //
    // A VALID DROP TARGET WEARS THE OTHER PLATE. `ui_inventory_cell_hover` is the
    // same 40x40 cut as `ui_inventory_cell_empty` and has been on disk, unused,
    // since M6; this is its first reader. Swapping the plate rather than adding a
    // ring means the signal is in the middle of the cell, where the thing being
    // dragged is about to land, rather than on an edge shared with two other
    // meanings (focus and pointer-hover).
    const plateId = dropTarget ? 'ui_inventory_cell_hover' : 'ui_inventory_cell_empty';
    if (!blitCentred(ctx, sprites, plateId, well)) {
      // The primitives fallback traces a box where the 40x40 plate would have
      // been. `client/public/assets/` is gitignored wholesale, so this is not a
      // degraded state — it is what every fresh clone renders.
      traceBox(
        ctx,
        {
          x: well.x + Math.floor((well.w - PLATE_PX) / 2),
          y: well.y + Math.floor((well.h - PLATE_PX) / 2),
          w: PLATE_PX,
          h: PLATE_PX,
        },
        dropTarget ? PALETTE.PARCHMENT : PALETTE.SLATE,
      );
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

  // ═══ AN EMPTY SLOT SAYS WHICH SLOT IT IS, ALWAYS, ART OR NO ART ═══
  // This used to be the `else` of the plate blit, so on a machine that HAD the
  // art the word `offhand` never appeared in the cell at all — the plate is one
  // generic 40x40 picture, identical in all seven boxes, so the doll read as
  // seven interchangeable gaps. The caption is what makes each one a PLACE.
  //
  // DEVIATION, AND IT IS THE PLATE'S FAULT RATHER THAN A STYLE CHOICE. Upstream
  // never labels an empty slot: `drawItemShortName` early-returns at
  // EquipDollFrame.lua:115 (`if self.no_name or not o then return end`), because
  // ToME ships FIFTEEN authored per-slot silhouettes — head_inv.png, boots_inv.png,
  // ring_inv.png, amulet_inv.png, body_inv.png and the rest, load.lua:120-134 —
  // threaded in as `bg_empty` (EquipDoll.lua:176) and painted at
  // EquipDollFrame.lua:172-177. A picture of a boot needs no word under it. We
  // have exactly one generic plate and a new sprite id is forbidden twice over
  // (test/client/assets.test.ts pins the loader's prefix array, and this file's
  // own test pins that every id here is a literal), so a word is the only way an
  // empty slot can name itself.
  //
  // INSIDE THE CELL rather than under it, which IS a departure from upstream's
  // `name_pos == "bottom"` (EquipDollFrame.lua:128-130, `y = y + self.h`): our
  // pitch leaves five pixels between rows and a 10px glyph does not fit in five.
  // The 40x40 plate leaves twelve pixels clear at the bottom of the 64px well,
  // which is exactly enough.
  if (cell.kind === 'empty') {
    ctx.font = FONT_BODY;
    ctx.textAlign = 'center';
    ctx.fillStyle = dropTarget ? PALETTE.PARCHMENT : PALETTE.GREY_HI;
    ctx.fillText(
      fitText(ctx, cell.slot, well.w),
      well.x + well.w / 2,
      well.y + well.h - CAPTION_BASELINE,
    );
    ctx.textAlign = 'left';
  }

  // A FILLED DROP TARGET GETS THE EDGE INSTEAD OF THE PLATE, because the plate
  // would sit on top of the icon and hide the very thing the drop would replace.
  // It is safe to spend PARCHMENT on an edge here even though the pointer-hover
  // ring is also PARCHMENT: the caller suppresses every hover hit test while a
  // drag is live (main.ts's drag decision), so the two signals cannot be on
  // screen at the same time.
  if (dropTarget && cell.kind === 'item') {
    traceBox(ctx, box, PALETTE.PARCHMENT);
    traceBox(ctx, { x: box.x + 1, y: box.y + 1, w: box.w - 2, h: box.h - 2 }, PALETTE.PARCHMENT);
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
 * THE FIGURE IN THE MIDDLE OF THE DOLL.
 *
 * ToME blits the ACTOR here — `self.actor:toScreen(nil, x + doll.doll_x, y +
 * self.base_doll_y + doll.doll_y, doll.doll_w, doll.doll_h)` at EquipDoll.lua:238
 * — into the 128x128 hole the frame table leaves at doll_x=116, doll_y=232
 * (load.lua:140). We have no posed actor sprite and may not cut one, so the class
 * portrait that is already on the wire and already on disk goes there instead.
 *
 * THE FALLBACK IS A DRAWN FIGURE RATHER THAN AN EMPTY BOX, and that is not
 * decoration. `client/public/assets/` is gitignored wholesale, so a bare clone has
 * NO portrait, and an empty rectangle in the middle of the doll would read as a
 * broken cell — the exact "is that a slot?" question the captions were added to
 * kill. Five `fillRect`s in SLATE read as a person at a glance and ask for no art.
 * The unit is derived from the region so the same code serves the full 149x149
 * region and the 72-pixel-tall one a shed bottom row leaves behind.
 */
function drawPortrait(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  box: PanelRect,
  id: string | null,
): void {
  if (box.w <= 0 || box.h <= 0) return;

  ctx.fillStyle = PALETTE.VOID;
  ctx.fillRect(box.x, box.y, box.w, box.h);
  traceBox(ctx, box, PALETTE.SLATE);

  // NAMED BY THE CALLER, NEVER ASSEMBLED. `id` is an `icon_character_the_*` key
  // the SERVER chose (src/server/view/projector.ts:387-393); this file could not
  // build one correctly if it wanted to, because the mapping from class to face
  // includes a generic fallback for the three classes that do not exist yet.
  if (id !== null && blitCentred(ctx, sprites, id, box)) return;

  // Eleven units tall: 3 head, 5 torso, 3 legs. Floored to at least one pixel so
  // an absurdly small region degrades to a smudge rather than to nothing.
  const unit = Math.max(1, Math.floor(Math.min(box.w, box.h) / 12));
  const cx = box.x + Math.floor(box.w / 2);
  const top = box.y + Math.floor((box.h - unit * 11) / 2);

  // EVERY COORDINATE IS AN INTEGER. The backbuffer is magnified by a whole factor
  // with smoothing off, so a rect on a half pixel is the one antialiased edge on
  // the screen — the rule ui/panel.ts:345-348 states for its 1px borders.
  const head = unit * 3;
  const torso = unit * 5;
  const leg = unit * 2;
  ctx.fillStyle = PALETTE.SLATE;
  ctx.fillRect(cx - Math.floor(head / 2), top, head, head);
  ctx.fillRect(cx - Math.floor(torso / 2), top + head, torso, torso);
  ctx.fillRect(cx - Math.floor(torso / 2), top + head + torso, leg, unit * 3);
  ctx.fillRect(cx + Math.floor(torso / 2) - leg, top + head + torso, leg, unit * 3);
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

  // ═══ THE ONE-LINE STRIP: NAME LEFT, AND EITHER DROP OR THE META RIGHT ═══
  // The Equipped tab reserves one line because the wire has nothing else to put
  // there (`DETAIL_COMPACT_H`). What it CAN say still gets said: which thing the
  // strip is about, and what that thing is — or, when the sticky focus is still on
  // a bag item the player looked at before switching tabs, the DROP control, which
  // must stay reachable or the focus rule at `InventoryFocus` is broken from the
  // other end.
  if (row.compact) {
    if (row.title === '') {
      // Nothing pointed at: the hint takes the whole line, on the left, because it
      // is an instruction rather than a label for something.
      ctx.font = FONT_BODY;
      ctx.fillStyle = PALETTE.GREY_HI;
      ctx.fillText(fitText(ctx, row.meta, rect.w), rect.x, y);
      return;
    }
    ctx.font = FONT_NAME;
    ctx.fillStyle = PALETTE.PARCHMENT;
    ctx.fillText(fitText(ctx, row.title, Math.floor(titleW / 2)), rect.x, y);
    if (placed.drop !== null && row.action !== null) {
      drawButton(ctx, placed.drop, row.action.label, {
        ink: buttonInk(row.action, hoveredDrop),
      });
      return;
    }
    ctx.font = FONT_BODY;
    ctx.textAlign = 'right';
    ctx.fillStyle = PALETTE.GREY_HI;
    ctx.fillText(fitText(ctx, row.meta, Math.floor(rect.w / 2)), right, y);
    ctx.textAlign = 'left';
    return;
  }

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
    if (row.action !== null) {
      drawButton(ctx, placed.drop, row.action.label, {
        ink: buttonInk(row.action, hoveredDrop),
      });
    }
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
        const tab = row.tabs[i];
        if (box === undefined || tab === undefined) continue;
        const selected = tab === row.tab;
        // THE COUNT IS ON THE TAB, which is how the bag says "five of twelve"
        // without a thirteenth cell existing to say it. BRACKETS mark the
        // selected tab as well as the colour does: never colour alone
        // (ui/partypanel.ts:78-92).
        const label =
          tab === InventoryTab.Equipped
            ? `EQUIPPED ${String(row.wornCount)}/${String(SLOT_ORDER.length)}`
            : tab === InventoryTab.Carried
              ? `CARRIED ${String(row.carriedCount)}/${String(CARRIED_MAX)}`
              : `SHOP ${String(row.shopCount)}`;
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
        drawCell(ctx, sprites, cell, box, sameFocus(focus, self), sameFocus(hovered, self), false);
      }
      return;
    }

    case InventoryRowKind.Doll: {
      // THE PORTRAIT FIRST. It shares no pixel with any cell — the placement table
      // leaves columns 1-2 of rows 0-1 to it — so the order is only about reading:
      // the figure is the thing the slots are arranged around.
      if (placed.portrait !== null) drawPortrait(ctx, sprites, placed.portrait, row.portrait);
      for (let i = 0; i < placed.cells.length; i += 1) {
        const box = placed.cells[i];
        const cell = row.cells[i];
        if (box === undefined || cell === undefined) continue;
        const self: InventoryFocus =
          cell.kind === 'item'
            ? { kind: 'item', itemId: cell.itemId }
            : { kind: 'slot', slot: cell.slot };
        drawCell(
          ctx,
          sprites,
          cell,
          box,
          sameFocus(focus, self),
          sameFocus(hovered, self),
          row.dropSlot !== null && cell.slot === row.dropSlot,
        );
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
  /**
   * Gold, straight off the inventory frame. Defaults to 0 so a caller that has
   * not been taught to pass it draws `INVENTORY` exactly as it did before —
   * which is what keeps the existing panel tests honest rather than updated.
   */
  readonly money?: number;
  /**
   * THE SHOP IN THIS ROOM, or null for a room with no shop.
   *
   * NAME AND COUNT ONLY, not the shelf itself. This panel does not sell
   * anything yet; what it does is stop a player walking past a shop without
   * knowing it is there, which is the single most expensive thing a town can do
   * to a first session.
   */
  readonly shop?: { readonly name: string; readonly count: number } | null;
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
  const money = options.money ?? 0;
  const shop = options.shop ?? null;
  if (rect.w <= 0 || rect.h <= 0) return;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  drawPanel(ctx, sprites, PanelSkin.CaseFile, rect);
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();

  drawHeader(ctx, sprites, panelTitle(money, shop), rect, FONT_META);

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
