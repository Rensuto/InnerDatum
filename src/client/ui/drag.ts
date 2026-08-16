/**
 * THE DRAG PRIMITIVES. Pure arithmetic, no DOM, no listeners, no state.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DEVIATION, LABELLED AS ONE: ToME'S DIALOGS ARE NOT DRAGGABLE.
 * ═══════════════════════════════════════════════════════════════════════════
 * There is NO upstream citation for a movable window and none is invented here.
 * reference/t-engine4/game/engines/default/engine/ui/Dialog.lua is 950 lines
 * long and carries no move handle: it has `move(x, y)` for placement and
 * `setupUI` for centring, and nothing that reads a pointer to reposition itself.
 * `grep -rn "moveDialog|drag_dialog|is_moving|self.moving" reference/t-engine4/
 * game/` returns nothing at all. Upstream's answer to "the dialog is in the way"
 * is to close it; ours is to move it, because our panels are explicitly NOT
 * modals (main.ts's `HudLayout` field docs, most fully at main.ts:1966-1991) and
 * a panel you can read WHILE the game continues is a panel that will sometimes
 * be sitting on the tile you want to look at.
 *
 * The ONE real citation in this file is the 6-pixel gesture threshold at
 * DRAG_THRESHOLD_PX, which is upstream's and is quoted verbatim there. It is a
 * citation for the THRESHOLD only. Nothing else here claims a source.
 *
 * WHY A SEPARATE MODULE AT ALL, when the offsets themselves live in main.ts.
 * Four panel modules, the painter and every hit test have to agree — to the
 * pixel — about where a moved panel IS. That is the same rule `slotRect` in
 * ui/hotbar.ts established and that `hudLayout` in main.ts enforces for every
 * other rect on screen: two copies of a panel's position is how a click lands on
 * a tile that is underneath it, and the bug only shows up on somebody else's
 * window size. So there is exactly ONE clamp (`moveIntoBand`), exactly one
 * threshold, and exactly one offset-composition rule, and they live somewhere
 * that can be unit-tested without a canvas.
 *
 * WHAT IS NOT HERE, DELIBERATELY: the offset STORE (module state in main.ts,
 * session-local, reset on reload exactly like `logVisible`/`partyVisible`), the
 * listeners (on `window`, not the canvas — a canvas-driven drag freezes the
 * moment the pointer crosses onto `#cmdrow`), and any notion of which panel is
 * currently being dragged. This file is arithmetic. It ships before anything
 * that uses it so that the arithmetic can be wrong in a test rather than in a
 * session.
 */

import type { Slot } from '../../shared/protocol.ts';
import type { PanelRect } from './panel.ts';

/**
 * THE FOUR PANELS A PLAYER MAY MOVE, and — just as load-bearing — the list of
 * what is deliberately left out.
 *
 * An `as const` object plus a derived type rather than an `enum`: the server
 * type-strips `src/**` and runs it directly, so `erasableSyntaxOnly` is on and
 * an enum would not survive (CLAUDE.md § 1). Same shape as `PanelSkin` in
 * ui/panel.ts, `Slot` in shared/protocol.ts and every other closed set here.
 *
 * DRAGGABLE: the character sheet, the talent panel, the inventory panel and the
 * escape menu. All four are read at leisure while the game continues, all four
 * are drawn from `panelBand`, and all four are things a player will eventually
 * want to see PAST.
 *
 * NOT DRAGGABLE, one reason each — every one of these is a real answer, not an
 * omission, and a later pass that "finishes the job" by adding one of them is
 * breaking something:
 *
 *   THE CLASS PICKER    is a scrimmed, full-viewport MODAL (classpicker.ts:179
 *                       -200 computes it from the whole viewport precisely
 *                       because "a modal is allowed to cover the hotbar:
 *                       nothing under it is pressable while it is up"). It
 *                       never answers null, it must be resolved before anything
 *                       else is actionable, and moving it buys the player
 *                       nothing while costing a fifth clamp rule — its rect is
 *                       not band-derived, so `moveIntoBand` does not even
 *                       describe it.
 *
 *   THE PARTY PANE      chooses Rows vs Portraits from how much clear map is
 *                       left, via a `rightReserved` handshake with the Case Log
 *                       (partypanel.ts:337-343 measures `width - rightReserved
 *                       - paneW`; main.ts:2090-2092 feeds it the log's width).
 *                       A free-floating pane makes that computation meaningless
 *                       — it would still shrink itself to protect a strip of
 *                       map it is no longer sitting next to.
 *
 *   THE CASE LOG        is the other half of that same handshake. Move it and
 *                       the pane silently picks the wrong form.
 *
 *   THE HOTBAR          is the ANCHOR. `panelBand`'s bottom is derived from
 *                       `HOTBAR_TOTAL_H` at main.ts:540, so every rect in this
 *                       file's clamp is measured against where the hotbar is. A
 *                       movable hotbar ungrounds all four draggable panels at
 *                       once.
 *
 *   THE ERASED PLATE    is a plate, not a panel: it says one thing, it offers
 *                       one key, and it already stands down entirely while the
 *                       escape menu is open (main.ts:2100-2120). There is
 *                       nothing to read past.
 *
 *   THE TOKEN MENU      opens AT the pointer by definition — a right-click menu
 *   AND HOVER CARD      that is not under the cursor is a right-click menu that
 *                       has lost its referent.
 */
export const DraggablePanel = {
  Sheet: 'sheet',
  Talents: 'talents',
  Inventory: 'inventory',
  Menu: 'menu',
} as const;
export type DraggablePanel = (typeof DraggablePanel)[keyof typeof DraggablePanel];

/**
 * Every draggable panel, once, in a form a test or a `for` loop can walk.
 *
 * Typed as `readonly DraggablePanel[]` and built from the object above so it
 * cannot fall out of step with it — the same device `SLOT_ORDER` uses at
 * shared/protocol.ts:1279.
 */
export const DRAGGABLE_PANELS: readonly DraggablePanel[] = [
  DraggablePanel.Sheet,
  DraggablePanel.Talents,
  DraggablePanel.Inventory,
  DraggablePanel.Menu,
] as const;

/**
 * How far a panel has been dragged from where `hudLayout` would have put it, in
 * LOGICAL BACKBUFFER pixels — the same space every `*Rect` helper and every hit
 * test already works in, so no conversion happens anywhere.
 *
 * IT IS A DELTA, NOT A POSITION, and that is the entire resize answer. A stored
 * position would have to be re-derived every time the viewport changed; a delta
 * is re-applied to a freshly computed rect, so a panel that is centred stays
 * centred-plus-40 when the window grows.
 */
export type PanelOffset = {
  readonly dx: number;
  readonly dy: number;
};

/** The offset of a panel nobody has moved. Shared so `{dx:0,dy:0}` is written once. */
export const NO_OFFSET: PanelOffset = { dx: 0, dy: 0 };

/**
 * A fresh store: all four panels at their computed positions.
 *
 * Returns a MUTABLE record of IMMUTABLE offsets — the caller (main.ts, module
 * scope) reassigns whole `PanelOffset` values as a drag proceeds and never
 * mutates one in place, which is what makes `nextOffset` a pure function of the
 * offset captured at the grab rather than of whatever the last frame left
 * behind. Built by walking `DRAGGABLE_PANELS` so adding a fifth panel to the
 * union cannot leave a hole here.
 */
export function createPanelOffsets(): Record<DraggablePanel, PanelOffset> {
  const out = {} as Record<DraggablePanel, PanelOffset>;
  for (const panel of DRAGGABLE_PANELS) out[panel] = NO_OFFSET;
  return out;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CLAMP. THERE IS EXACTLY ONE COPY OF THIS AND IT IS THIS ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE RULE: add the offset to the rect, then clamp `y` into
 * `[band.top, band.bottom - rect.h]` and `x` into `[0, width - rect.w]`. `w` and
 * `h` are never touched — a drag moves a panel, it does not resize one, and a
 * clamp that shrank a panel to make it fit would change what the panel can show
 * as a side effect of where it was dropped.
 *
 * THE TARGET IS THE BAND, NOT THE VIEWPORT, AND THAT IS THE WHOLE PANEL-NOT-
 * MODAL DECISION MADE MECHANICAL. `hudLayout`'s own field docs state the rule
 * four times, most explicitly at main.ts:1972-1980: "Clamped into the band it
 * can never come to rest over the hotbar, the resource strip or the prose lines
 * — so every control stays visible and pressable underneath it while a player
 * reads, and the four talent keys still work with the menu open. That is what
 * makes this a PANEL: the server is never told it is up, nothing parks a body,
 * no standing order is set, and the quorum counts the reader exactly as it
 * counts everybody else." A VIEWPORT clamp would let a player park the escape
 * menu over the hotbar and make the four talent keys invisible while the menu is
 * up — the panel-not-modal promise broken by a gesture rather than by a code
 * change, which is precisely the kind of regression no review catches, because
 * no line of code would have changed to cause it. `panelBand` (main.ts:534-541)
 * derives `bottom` from `HOTBAR_TOTAL_H`, `RESOURCE_H` and `LINE_H`, so clamping
 * to it is not an extra safeguard bolted on for the drag — it is the EXISTING
 * safeguard left intact.
 *
 * THE DEGENERATE CASES PIN RATHER THAN INVERT. If the band is shorter than the
 * panel (`band.bottom - rect.h < band.top`) the allowed range is empty, and the
 * naive `min(max(...))` would answer `band.bottom - rect.h`, i.e. a NEGATIVE y
 * on a short viewport — the panel would be dragged clean off the top of the
 * screen by a clamp whose whole job is to keep it on. Pin to `band.top`
 * instead: the header, which carries the title and the close control, is the
 * half that must stay reachable. Same rule on x when the viewport is narrower
 * than the panel. Both cases are reachable in practice: the four `*Rect` helpers
 * answer null on a band too short, but the band is recomputed every frame and a
 * viewport can shrink between the frame that produced the rect and the frame
 * that clamps it.
 *
 * PURE, and takes the band and the width rather than reading them: it is called
 * from inside `hudLayout`, which is rebuilt per call by design
 * (main.ts:1904-1906), so there is nothing to cache and nothing to invalidate.
 */
export function moveIntoBand(
  rect: PanelRect,
  offset: PanelOffset,
  band: { readonly top: number; readonly bottom: number },
  width: number,
): PanelRect {
  const maxY = band.bottom - rect.h;
  const wantY = rect.y + offset.dy;
  const y = maxY <= band.top ? band.top : Math.min(Math.max(wantY, band.top), maxY);

  const maxX = width - rect.w;
  const wantX = rect.x + offset.dx;
  const x = maxX <= 0 ? 0 : Math.min(Math.max(wantX, 0), maxX);

  return { x, y, w: rect.w, h: rect.h };
}

/**
 * How far the pointer must travel before a press becomes a DRAG rather than a
 * CLICK, in logical pixels.
 *
 * PORTED VERBATIM from reference/t-engine4/game/engines/default/engine/
 * Mouse.lua:177, which reads:
 *
 *     if _M.drag.prestart and math.max(math.abs(_M.drag.start_x - x),
 *     math.abs(_M.drag.start_y - y)) > 6 then
 *
 * — a Chebyshev distance against a literal 6, and STRICTLY GREATER THAN. The
 * comparison direction is not a detail: at exactly 6 pixels upstream is still a
 * click, and `>=` here would make a panel header a surface where a firm click
 * sometimes moves the window instead of pressing what is under the cursor.
 *
 * WHY A THRESHOLD EXISTS AT ALL: a header strip carries the title AND, on the
 * character sheet, the `[G]` control beside the close. Without a threshold every
 * press on that strip would begin a one-pixel drag, and a player with an
 * unsteady hand would find that clicking a button sometimes shoved the panel
 * sideways instead. Below the threshold the press stays a plain click and the
 * panel does not move at all.
 */
export const DRAG_THRESHOLD_PX = 6;

/**
 * Has this press travelled far enough to be a drag?
 *
 * Chebyshev, not Euclidean, and `>` not `>=`, both straight from Mouse.lua:177.
 * A diagonal move of exactly 6 in each axis is still a click upstream and is
 * still a click here.
 */
export function passesThreshold(startX: number, startY: number, x: number, y: number): boolean {
  return Math.max(Math.abs(startX - x), Math.abs(startY - y)) > DRAG_THRESHOLD_PX;
}

/**
 * The offset a live drag has reached: where it was when the header was grabbed,
 * plus how far the pointer has moved since.
 *
 * ═══ RAW AND UNCLAMPED *DURING* THE GESTURE, SETTLED ON RELEASE ═══
 * Raw here is what makes the panel follow the pointer honestly while the button
 * is down: a pointer that has swept 400px past the band edge and comes back is
 * back in range at the pixel it re-enters, because the offset is always
 * recomputed from `offsetAtGrab` plus the TOTAL travel rather than accumulated
 * frame by frame. Nothing draws or hit tests against this value — `moveIntoBand`
 * clamps every read (`movePanel` in main.ts is the only application site).
 *
 * WHAT THIS FUNCTION MUST NOT BE ALLOWED TO DO IS OUTLIVE THE GESTURE. The raw
 * value is a POINTER POSITION expressed as a delta; the stored value has to be a
 * PANEL POSITION. Leaving the raw value in the store was a shipped bug: the next
 * `beginDrag` re-based on a dy of +423 while the pointer re-based on the drawn
 * y the clamp had pinned at +29, so the player had to pay 394 pixels back before
 * the title bar moved again — four consecutive full-height drags that moved the
 * panel nothing at all, which is a handle that visibly does not work. So the
 * release runs `settleOffset` and stores the offset the clamp ACTUALLY honoured.
 *
 * THE RESIZE ANSWER SURVIVES THAT INTACT, because it was never about a gesture:
 * `hudLayout` is rebuilt per call by design (main.ts:1904-1906), so a viewport
 * that shrinks re-runs `moveIntoBand` against the smaller band on the very next
 * frame and the panel walks back into view by itself, and growing it again
 * restores the player's choice — nothing is written on a resize, so nothing of
 * theirs can be overwritten by one. Settling on RELEASE only ever records a
 * position the band was willing to draw at the moment they let go.
 */
export function nextOffset(
  offsetAtGrab: PanelOffset,
  grabX: number,
  grabY: number,
  x: number,
  y: number,
): PanelOffset {
  return { dx: offsetAtGrab.dx + (x - grabX), dy: offsetAtGrab.dy + (y - grabY) };
}

/**
 * WHERE THE PANEL ACTUALLY LANDED, as an offset. Run once, on release.
 *
 * Takes the UNMOVED rect — the one the panel's own `*Rect` helper computes for
 * this frame's band, before any drag is applied — and the raw offset the gesture
 * reached, and answers the difference between where the panel WOULD have been
 * and where `moveIntoBand` was willing to put it. That is the offset the player
 * can see, so it is the only one worth remembering.
 *
 * IT IS `moveIntoBand` AND NOT A SECOND CLAMP. There is exactly one copy of the
 * clamp rule in this codebase and this function calls it rather than restating
 * it; a settle that rounded differently from the draw would put the panel one
 * pixel from where it was released, every release.
 *
 * IDEMPOTENT BY CONSTRUCTION: settling an already-settled offset re-clamps a
 * position already inside the band and answers the same numbers. That is what
 * makes it safe for `cancelDrag` to restore `offsetAtGrab` — every stored offset
 * has been through here, so a cancel restores a reachable position.
 */
export function settleOffset(
  rect: PanelRect,
  offset: PanelOffset,
  band: { readonly top: number; readonly bottom: number },
  width: number,
): PanelOffset {
  const landed = moveIntoBand(rect, offset, band, width);
  return { dx: landed.x - rect.x, dy: landed.y - rect.y };
}

/**
 * WHAT A DRAG IS CARRYING. Three kinds, and the set is closed.
 *
 * `Panel` is this pass's gesture — a header strip being pushed around inside the
 * band. `Carried` and `Worn` are the two ITEM drags the inventory work needs: a
 * bag item dragged onto a paperdoll slot or onto an empty hotbar slot, and a
 * worn item dragged off the doll. They are distinct kinds rather than one item
 * kind with a flag because the VERB differs and the IDENTIFIER differs — a
 * carried item is named by `itemId` and equipping it sends `equip {itemId}`,
 * while a worn item is named by its SLOT and removing it sends `unequip {slot}`
 * (shared/protocol.ts:1949 takes `z.enum(SLOT_ORDER)`, not an item id). Folding
 * them together would mean a drop handler that has to ask "which field is
 * populated" — which is a discriminated union with the discriminant filed off.
 *
 * `as const` object plus derived type, not an enum: `erasableSyntaxOnly`
 * (CLAUDE.md § 1).
 */
export const DragKind = {
  /** A panel header strip. The subject is which panel. */
  Panel: 'panel',
  /** An item in the bag. The subject is its `itemId`. */
  Carried: 'carried',
  /** An item already worn. The subject is the `Slot` it came off. */
  Worn: 'worn',
} as const;
export type DragKind = (typeof DragKind)[keyof typeof DragKind];

/**
 * A drag, with the one field its kind needs and no others.
 *
 * The discriminated union rather than three optional fields, for the reason
 * `DragKind`'s note gives: a drop target switches on `kind` and the compiler
 * then knows which identifier exists. `noUncheckedIndexedAccess` is on and
 * exhaustiveness is checked the way every other closed set in this codebase
 * checks it — a `switch` with a `default` that cannot be reached.
 *
 * NOTHING HERE IS A POSITION. A drag's current pointer position is the caller's
 * state, not the subject's; keeping them apart is what lets this whole module be
 * tested without a pointer.
 */
export type DragSubject =
  | { readonly kind: typeof DragKind.Panel; readonly panel: DraggablePanel }
  | { readonly kind: typeof DragKind.Carried; readonly itemId: string }
  | { readonly kind: typeof DragKind.Worn; readonly slot: Slot };
