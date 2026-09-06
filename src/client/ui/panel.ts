/**
 * The panel skins: a 9-slice, a 3-sliced header strip, and the one text helper
 * every panel in the client needs.
 *
 * WHY A 9-SLICE AT ALL. `ui_panel_9slice_case_file.png` and
 * `ui_panel_9slice_inset.png` are 48x48 with 16-pixel corners, which is the
 * whole point of them: the corners are drawn once and reused at every size, so
 * the Case Log can be 172 pixels tall on one machine and 240 on another without
 * anybody cutting a second PNG. The alternative — a fixed-size panel image —
 * would make the dock's height a property of the art rather than of the
 * viewport, and the viewport is decided by whatever size Discord felt like
 * giving the iframe.
 *
 * THE EDGES ARE STRETCHED, NOT TILED, AND THAT IS A DELIBERATE TRADE. Tiling is
 * the more correct answer for pixel art in general; it is also four to twelve
 * extra `drawImage` calls per edge per panel per frame. With
 * `imageSmoothingEnabled = false` — which the renderer sets on the backbuffer
 * and every drawer here re-asserts — a stretch is nearest-neighbour, so it
 * duplicates whole columns and rows of pixels rather than blurring between them.
 * A 16-pixel border stretched to 176 is eleven copies of the same column, which
 * is exactly what tiling would have produced for a border whose pattern does not
 * repeat within its 16 pixels. It is visibly wrong only for an edge with texture
 * along its length, and neither skin has one.
 *
 * IT DRAWS INTO THE BACKBUFFER, at logical scale, like every other `ui/` module
 * — see the long note at the top of render/canvas.ts. So the panel sits on the
 * same pixel grid as the world and is magnified by the same integer factor.
 */

import { PALETTE } from '../render/canvas.ts';
import type { SpriteSource } from '../render/assets.ts';

/** The 9-slice skins on disk. Both 48x48 with 16px corners. */
export const PanelSkin = {
  /** The outer dossier. Heavier border — the party panel wears this. */
  CaseFile: 'ui_panel_9slice_case_file',
  /** The recessed well. Lighter, reads as "sunk into" — the Case Log wears this. */
  Inset: 'ui_panel_9slice_inset',
} as const;
export type PanelSkin = (typeof PanelSkin)[keyof typeof PanelSkin];

/**
 * Corner size, in source pixels. Must match how the PNGs were drawn; it is not a
 * free parameter, and getting it wrong shows up as a border that grows a seam a
 * third of the way along each edge.
 */
export const PANEL_CORNER = 16;
/** Authored size of both 9-slice PNGs. */
const PANEL_SRC = 48;
/** Authored size of `ui_panel_header_strip`. 3-sliced horizontally. */
const HEADER_SRC_W = 96;
export const HEADER_H = 24;

export type PanelRect = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

/** Standard inner padding, so two panels never disagree about their gutter. */
export const PANEL_PAD = 5;

/** The content box of a panel: the rect minus the border and the gutter. */
export function panelInner(rect: PanelRect): PanelRect {
  const inset = PANEL_PAD + 3;
  return {
    x: rect.x + inset,
    y: rect.y + inset,
    w: Math.max(0, rect.w - inset * 2),
    h: Math.max(0, rect.h - inset * 2),
  };
}

/**
 * The fallback panel, used when the skin PNG is missing.
 *
 * A traced box rather than the renderer's loud violet "missing asset" marker,
 * deliberately: the panel is the BACKGROUND of a surface people read, and a
 * screaming placeholder behind the Case Log would make the log unreadable at
 * exactly the moment the art pipeline regressed. The border is still drawn, so
 * the panel keeps its shape and everything inside it still lands correctly.
 */
function tracePanel(ctx: CanvasRenderingContext2D, rect: PanelRect): void {
  ctx.fillStyle = PALETTE.PANEL;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.fillStyle = PALETTE.SLATE;
  ctx.fillRect(rect.x, rect.y, rect.w, 1);
  ctx.fillRect(rect.x, rect.y + rect.h - 1, rect.w, 1);
  ctx.fillRect(rect.x, rect.y, 1, rect.h);
  ctx.fillRect(rect.x + rect.w - 1, rect.y, 1, rect.h);
}

/**
 * Paint one 9-slice panel.
 *
 * The four corners are blitted 1:1; the four edges stretch along one axis; the
 * centre stretches along both. A rect smaller than two corners in either
 * direction cannot be sliced at all — the corners would overlap and the middle
 * would have negative width — so that case degrades to the traced box rather
 * than drawing a `drawImage` with a negative source rectangle, which throws.
 */
export function drawPanel(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  skin: PanelSkin,
  rect: PanelRect,
): void {
  const sprite = sprites.sprite(skin);
  const c = PANEL_CORNER;
  if (sprite === undefined || rect.w < c * 2 || rect.h < c * 2 || sprite.w !== PANEL_SRC) {
    tracePanel(ctx, rect);
    return;
  }

  const img = sprite.image;
  const { x, y, w, h } = rect;
  // Source and destination middles. `PANEL_SRC - c * 2` is 16 for a 48px skin.
  const sm = PANEL_SRC - c * 2;
  const dmW = w - c * 2;
  const dmH = h - c * 2;

  ctx.save();
  ctx.imageSmoothingEnabled = false;

  // Corners, 1:1.
  ctx.drawImage(img, 0, 0, c, c, x, y, c, c);
  ctx.drawImage(img, PANEL_SRC - c, 0, c, c, x + w - c, y, c, c);
  ctx.drawImage(img, 0, PANEL_SRC - c, c, c, x, y + h - c, c, c);
  ctx.drawImage(img, PANEL_SRC - c, PANEL_SRC - c, c, c, x + w - c, y + h - c, c, c);

  // Edges, stretched along their run.
  ctx.drawImage(img, c, 0, sm, c, x + c, y, dmW, c);
  ctx.drawImage(img, c, PANEL_SRC - c, sm, c, x + c, y + h - c, dmW, c);
  ctx.drawImage(img, 0, c, c, sm, x, y + c, c, dmH);
  ctx.drawImage(img, PANEL_SRC - c, c, c, sm, x + w - c, y + c, c, dmH);

  // Centre.
  ctx.drawImage(img, c, c, sm, sm, x + c, y + c, dmW, dmH);

  ctx.restore();
}

/**
 * A header strip with a title on it — the tab at the top of a panel.
 *
 * `ui_panel_header_strip` is 96x24, so it is 3-sliced horizontally with the same
 * 16-pixel caps. Vertically it is used at its authored height and never scaled:
 * a strip stretched to 12 pixels tall reads as a squashed bar rather than as a
 * tab, and the one thing a header has to do is look like a different KIND of
 * thing from the panel under it.
 *
 * Returns the y coordinate immediately below the strip, so callers stack rather
 * than re-adding a constant that can drift.
 */
export function drawHeader(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  title: string,
  rect: PanelRect,
  font: string,
): number {
  const sprite = sprites.sprite('ui_panel_header_strip');
  const c = PANEL_CORNER;
  const { x, y, w } = rect;

  ctx.save();
  ctx.imageSmoothingEnabled = false;

  if (sprite !== undefined && w >= c * 2 && sprite.w === HEADER_SRC_W) {
    const img = sprite.image;
    const sm = HEADER_SRC_W - c * 2;
    ctx.drawImage(img, 0, 0, c, HEADER_H, x, y, c, HEADER_H);
    ctx.drawImage(img, c, 0, sm, HEADER_H, x + c, y, w - c * 2, HEADER_H);
    ctx.drawImage(img, HEADER_SRC_W - c, 0, c, HEADER_H, x + w - c, y, c, HEADER_H);
  } else {
    ctx.fillStyle = PALETTE.SLATE;
    ctx.fillRect(x, y, w, HEADER_H);
    ctx.fillStyle = PALETTE.GREY;
    ctx.fillRect(x, y + HEADER_H - 1, w, 1);
  }

  ctx.font = font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = PALETTE.GOLD;
  ctx.fillText(fitText(ctx, title, w - PANEL_PAD * 2), x + PANEL_PAD, y + HEADER_H / 2);
  ctx.restore();

  return y + HEADER_H;
}

/**
 * THE HEADER STRIP AS A DRAG HANDLE — the strip minus the controls carved out of
 * its right end.
 *
 * ONE COPY, HERE, for the reason every other geometry helper in this client is
 * one copy: the painter that highlights the handle, the `mousedown` that starts
 * the gesture and the tests all have to agree to the pixel, and four panel
 * modules each deriving "the header, but not the buttons" is four chances for
 * one of them to be three pixels out. The bug that produces is a header that
 * looks grabbable and, on one panel, starts a drag when you press the close
 * control — which then closes the panel on mouseup, having moved it first.
 *
 * `reservedRight` is how many pixels at the right end belong to that panel's own
 * header controls, measured from the panel's right edge inward. Each caller
 * derives it from ITS OWN close/`[G]` arithmetic, which stays private to that
 * module: three of the four panels reserve `PANEL_PAD + CLOSE_PX`, and the
 * character sheet reserves that plus the gap and the `[G]` button beside it
 * (ui/charsheet.ts's `talentsRect`). This function deliberately does NOT know
 * those numbers — a second authority on where the close control is would be the
 * exact duplication it exists to prevent.
 *
 * `HEADER_H` EXACTLY, never a pixel more: the strip is the only part of a panel
 * that reads as a different KIND of thing from the body (see `drawHeader`), and
 * a handle that extended into the body would make the rows draggable, which
 * means a click meant for a talent row would sometimes move the panel instead.
 *
 * Width floors at 0 rather than going negative — a panel narrower than its own
 * controls has no handle, which is the honest answer, and a negative-width rect
 * would pass a naive `px >= x && px < x + w` hit test for nothing at all but
 * would still be handed to `fillRect`.
 */
export function headerDragRect(rect: PanelRect, reservedRight: number): PanelRect {
  return {
    x: rect.x,
    y: rect.y,
    w: Math.max(0, rect.w - Math.max(0, reservedRight)),
    h: HEADER_H,
  };
}

/**
 * Trim to fit, with an ellipsis.
 *
 * A fourth copy of this existed in turnbar.ts and hotbar.ts before this file
 * did; both keep theirs (they are three lines and changing a working file to
 * import a helper is churn), but every M4 panel takes it from here so the log,
 * the party rows and the headers cannot disagree about what "too long" means.
 *
 * The caller must have set `ctx.font` — measurement is font-dependent and doing
 * it here would mean either taking the font as a parameter or silently measuring
 * against whatever the last drawer left behind.
 */
export function fitText(ctx: CanvasRenderingContext2D, text: string, maxPx: number): string {
  if (maxPx <= 0) return '';
  if (ctx.measureText(text).width <= maxPx) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxPx) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * Break `text` into lines that each fit `maxPx`, on word boundaries where it can
 * and mid-word where it must.
 *
 * WORD WRAPPING IS NOT OPTIONAL FOR THE CASE LOG. A Record line is a whole
 * sentence — "Dalt saves (phys 38 vs power 31, 68%) — Slowed 1 turn, not 3" —
 * and a 200-pixel column fits roughly thirty characters of it. Truncating with
 * an ellipsis would throw away the half of every line that carries the numbers,
 * which is the half people read the log for.
 *
 * The mid-word fallback exists because a Discord nickname can be 32 characters
 * with no spaces in it, and a single unbreakable token must not produce an
 * infinite loop or a line that overflows the panel.
 */
export function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxPx: number,
): readonly string[] {
  if (maxPx <= 0 || text === '') return [text];

  const out: string[] = [];
  let line = '';

  const flush = (): void => {
    out.push(line);
    line = '';
  };

  for (const word of text.split(' ')) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (ctx.measureText(candidate).width <= maxPx) {
      line = candidate;
      continue;
    }
    if (line !== '') flush();

    // The word alone still does not fit: chop it. One character at a time is
    // O(n) measurements per line and n is at most a few dozen here.
    let rest = word;
    while (rest !== '' && ctx.measureText(rest).width > maxPx) {
      let cut = rest.length - 1;
      while (cut > 1 && ctx.measureText(rest.slice(0, cut)).width > maxPx) cut -= 1;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }

  if (line !== '' || out.length === 0) out.push(line);
  return out;
}

/**
 * `wrapText`, BOUNDED — at most `maxLines`, with the overflow said rather than
 * dropped.
 *
 * A panel reserves a fixed number of lines for a paragraph, and the two numbers
 * have to be the same number: a wrap that returns four lines into a two-line
 * reservation draws over whatever is beneath it. So this clamps, and marks the
 * last line with an ellipsis when it clamped — which is the difference between a
 * sentence that ended and one that was cut, and it is the whole complaint that
 * started this work.
 *
 * PREFER MAKING THE RESERVATION BIG ENOUGH. This is the backstop for prose
 * nobody measured, not a licence to keep truncating: the caller that uses it
 * should also have a test proving its authored content fits.
 */
export function wrapClamped(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxPx: number,
  maxLines: number,
): readonly string[] {
  const lines = wrapText(ctx, text, maxPx);
  if (maxLines <= 0) return [];
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1] ?? '';
  kept[maxLines - 1] = fitText(ctx, `${last}…`, maxPx);
  return kept;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HOVER CARD — one primitive, every surface.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Asked for directly: tooltips on the talent tree, the bag and the action bar.
 * Three surfaces, and three private implementations would be three answers to
 * "what does a tooltip look like" — which teaches a player that one of them is
 * a different kind of thing. `drawButton` above carries the same argument for
 * the same reason, and it is the reason this file exists at all.
 *
 * ═══ IT IS NOT `ui/tooltip.ts` ═══
 * That one takes an `InspectView` and draws a creature's card: portrait, hit
 * points, rank, the blocked reason. It is a MONSTER tooltip and its shape is
 * about a body. This is a card of prose about a thing, which is what an item, a
 * talent and a hotbar slot all need and none of them is a body.
 *
 * ═══ IT CLAMPS RATHER THAN FLIPS, WHEN IT FOLLOWS THE POINTER ═══
 * A card that flipped sides near an edge would move under the pointer while the
 * pointer stood still, which reads as flicker. Clamping keeps it still: it slides
 * along the edge instead, and the pointer never loses the thing it is over.
 *
 * ═══ AND THAT ARGUMENT DOES NOT REACH AN ANCHORED CARD ═══
 * `anchor` places the card beside a FIXED RECT instead of centred on the
 * pointer, so the side it picks is a function of the rect and not of the cursor.
 * Moving the pointer within one cell cannot move the card at all; it moves when
 * you point at a different cell, which is the moment it is supposed to. So an
 * anchored card DOES flip, and gains nothing from clamping in its place.
 */
export type HoverCard = {
  readonly title: string;
  /** One line under the title — cost, slot, rank. Absent when there is none. */
  readonly meta?: string;
  /** The body. Already wrapped by the caller, which owns the width it wants. */
  readonly lines: readonly string[];
  /** A second block, drawn in gold — "what one more point buys". */
  readonly nextLines?: readonly string[];
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * PLACE THE CARD BESIDE THIS RECT instead of centred on the pointer.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A card centred on the pointer COVERS THE THING IT DESCRIBES whenever that
   * thing is smaller than the card. An inventory cell is 72 pixels and a card of
   * stats is nearer 250, so hovering a coat hid the coat, the cell beside it and
   * the row above — every time, at every window size. That is what the panel was
   * reported for.
   *
   * `tome/dialogs/ShowEquipInven.lua:65` is the same rule upstream:
   * `last_display_x = ui.ui.last_display_x + ui.ui.w` — the slot's tooltip is
   * anchored past the slot's right edge rather than at the mouse.
   *
   * ABSENT KEEPS THE OLD BEHAVIOUR. The map, the minimap and the party pane
   * describe things that are either under the pointer already or too large to
   * hide, and they pass no anchor.
   */
  readonly anchor?: PanelRect;
};

const CARD_PAD = 6;
const CARD_LINE_H = 12;
const CARD_GAP = 10;

/**
 * ════════════════════════════════════════════════════════════════════════════
 * THE BODY A CARD WILL ACTUALLY DRAW, BOUNDED BY THE SCREEN.
 * ════════════════════════════════════════════════════════════════════════════
 * THE WIDTH WAS CLAMPED AND THE HEIGHT WAS NOT, which was survivable only
 * while every card was short. `hoverCardRect` computed `h` from the row count
 * with no ceiling, and its `y` clamp collapses once `h` exceeds the viewport:
 * the inner `Math.max` bottoms out at `CARD_GAP` and the card runs off the
 * screen, unclipped and unscrollable. An item card lists one row per channel
 * the item moves, and `compareRows` can emit forty-four.
 *
 * SEPARATED FROM THE PAINTING SO IT CAN BE ASSERTED, exactly as
 * `hoverCardRect` below is and for its stated reason. THE BOX AND THE INK NOW
 * READ ONE ANSWER: the rect sizes itself from this list and the painter walks
 * this list, so they cannot disagree about how many lines there are — which is
 * the failure that would otherwise replace a clipped card, and a worse one,
 * because a box drawn for rows it never paints looks deliberate.
 *
 * `goldFrom` IS WHERE `lines` ENDS AND `nextLines` BEGINS. The painter used
 * two loops and two colours; one list needs the index instead, and carrying it
 * here keeps the split with the arithmetic that produced it.
 *
 * A CUT LIST STILL SAYS SO. The last slot is spent on the count rather than on
 * a row, for `inventory.ts`'s rule about its own strip: a table that stops
 * short without a word looks complete and is not.
 */
export function hoverCardBody(
  card: HoverCard,
  viewportH: number,
): { readonly body: readonly string[]; readonly goldFrom: number } {
  const all = [...card.lines, ...(card.nextLines ?? [])];
  const maxRows = Math.max(1, Math.floor((viewportH - CARD_GAP * 2 - CARD_PAD * 2) / CARD_LINE_H));
  // The title always costs a row; the meta line costs one when it exists.
  const budget = Math.max(1, maxRows - 1 - (card.meta === undefined ? 0 : 1));
  if (all.length <= budget) return { body: all, goldFrom: card.lines.length };
  return {
    body: [...all.slice(0, budget - 1), `…and ${String(all.length - (budget - 1))} more`],
    // THE ELISION LINE IS NOT `nextLines`. It is the card talking about
    // itself, so it must not take the gold that means "at the next rank".
    goldFrom: Math.min(card.lines.length, budget - 1),
  };
}

/**
 * How wide a card wants to be, so a caller can wrap its prose to fit.
 *
 * MEASURES THE BOUNDED BODY, not every line the card was built with: a card
 * sized against rows it will not draw is a box with a margin nobody asked for.
 */
export function hoverCardWidth(
  ctx: CanvasRenderingContext2D,
  card: HoverCard,
  viewportH: number,
): number {
  ctx.font = FONT_BUTTON;
  let widest = ctx.measureText(card.title).width;
  ctx.font = '10px ui-monospace, Consolas, monospace';
  for (const line of [card.meta ?? '', ...hoverCardBody(card, viewportH).body]) {
    widest = Math.max(widest, ctx.measureText(line).width);
  }
  return Math.ceil(widest) + CARD_PAD * 2;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE THE CARD LANDS. Separated from the painting so it can be ASSERTED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This was inline in `drawHoverCard`, which meant the one rule that matters —
 * a card must not cover the thing it describes — was reachable only by painting
 * to a canvas and reading pixels. Nothing in `test/` referenced this file, and
 * the overlap it produced for every inventory cell could never have failed a
 * test.
 *
 * `drawHoverCard` calls this and paints; a test calls this and measures. Neither
 * has its own copy of the arithmetic, so they cannot disagree.
 */
export function hoverCardRect(
  ctx: CanvasRenderingContext2D,
  card: HoverCard,
  px: number,
  py: number,
  viewportW: number,
  viewportH: number,
): PanelRect {
  const { body } = hoverCardBody(card, viewportH);
  const rows = 1 + (card.meta === undefined ? 0 : 1) + body.length;
  const w = Math.min(hoverCardWidth(ctx, card, viewportH), Math.max(80, viewportW - CARD_GAP * 2));
  // BOUNDED BY `hoverCardBody`, which is why this needs no clamp of its own:
  // `body` is already cut to what fits, so `h` cannot exceed the viewport.
  const h = CARD_PAD * 2 + rows * CARD_LINE_H;

  const anchor = card.anchor;
  /**
   * BESIDE THE ANCHOR, ON WHICHEVER SIDE HAS ROOM — and to the RIGHT first,
   * which is `tome/dialogs/ShowEquipInven.lua:65`'s side. The flip is decided by the rect, so
   * it cannot happen while the pointer is still (see the note on the type).
   *
   * The final `Math.max(CARD_GAP, …)` is the same clamp the pointer path uses
   * and matters for the same reason: a viewport narrower than the card plus its
   * gaps must still draw the card's left edge on screen rather than off it.
   */
  const x =
    anchor === undefined
      ? // Centred on the pointer — a card under the cursor covers the next thing
        // the player is about to point at.
        Math.min(Math.max(CARD_GAP, px - Math.floor(w / 2)), viewportW - w - CARD_GAP)
      : Math.max(
          CARD_GAP,
          anchor.x + anchor.w + CARD_GAP + w + CARD_GAP <= viewportW
            ? anchor.x + anchor.w + CARD_GAP
            : Math.min(anchor.x - w - CARD_GAP, viewportW - w - CARD_GAP),
        );
  // ABOVE THE POINTER BY PREFERENCE, below it when there is no room above, and
  // clamped either way — a card that ran off the bottom would be a description
  // the player can see the top two lines of.
  //
  // AN ANCHORED CARD LINES UP WITH ITS ANCHOR'S TOP instead, so the card and the
  // thing it describes read as one row rather than as two stacked objects.
  const above = py - h - CARD_GAP;
  const preferred = anchor === undefined ? (above < CARD_GAP ? py + CARD_GAP : above) : anchor.y;
  const y = Math.min(Math.max(CARD_GAP, preferred), Math.max(CARD_GAP, viewportH - h - CARD_GAP));

  return { x, y, w, h };
}

export function drawHoverCard(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  card: HoverCard,
  px: number,
  py: number,
  viewportW: number,
  viewportH: number,
): void {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * SELF-CONTAINED, WHICH IT WAS NOT. This was the only painter in ui/ with no
   * save/restore pair and no explicit `textBaseline`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * IT LEAKED `font`, `textAlign` and `fillStyle` into whatever painted next —
   * the trap `inventory.test.ts` pins for the inventory panel by name, and
   * `turncards.ts:786-790` records having been bitten by.
   *
   * AND IT READ A BASELINE IT NEVER SET. `cursor = y + CARD_PAD + 9` is
   * measured from the TOP of the box, which is only true while the ambient
   * baseline is `alphabetic`. Six painters in this directory set `middle`
   * (caselog, charsheet, classpicker, combatbanner, contextmenu, escapemenu) and
   * every one of them happens to restore it — so this worked by their good
   * manners rather than by anything here. Stated, not inherited.
   */
  ctx.save();
  ctx.textBaseline = 'alphabetic';

  /**
   * THE SNAPSHOT IS TAKEN BEFORE THE MEASUREMENT, not after it. `hoverCardRect`
   * calls `hoverCardWidth`, which ASSIGNS `ctx.font` twice in order to measure —
   * so a `save()` placed after the rect was computed would restore the font the
   * measurer left rather than the caller's, and leak just as surely while
   * looking balanced. A test pins the ordering because nothing else can see it.
   */
  const { x, y, w, h } = hoverCardRect(ctx, card, px, py, viewportW, viewportH);

  // THE INSET SKIN — this card sits ON another surface rather than being one.
  drawPanel(ctx, sprites, PanelSkin.Inset, { x, y, w, h });

  let cursor = y + CARD_PAD + 9;
  ctx.textAlign = 'left';
  ctx.font = FONT_BUTTON;
  ctx.fillStyle = PALETTE.PARCHMENT;
  ctx.fillText(fitText(ctx, card.title, w - CARD_PAD * 2), x + CARD_PAD, cursor);
  cursor += CARD_LINE_H;

  ctx.font = '10px ui-monospace, Consolas, monospace';
  if (card.meta !== undefined) {
    ctx.fillStyle = PALETTE.GREY_HI;
    ctx.fillText(fitText(ctx, card.meta, w - CARD_PAD * 2), x + CARD_PAD, cursor);
    cursor += CARD_LINE_H;
  }
  // ═══ THROUGH `fitText`, LIKE THE TITLE AND THE META ABOVE ═══
  // This was the only raw `fillText` in the card. `w` is `hoverCardWidth`
  // clamped against the viewport, so a card wider than the screen silently
  // painted its stat rows past its own right edge. Latent while every card was
  // narrow; the anchored placement makes a clamped card ordinary.
  //
  // ═══ ONE LOOP OVER `hoverCardBody`, WHICH IS WHAT `hoverCardRect` MEASURED ═══
  // It was two loops over `card.lines` and `card.nextLines` — the whole list,
  // however long — while the rect sized itself from the same unbounded pair. Now
  // that the body is CUT to the viewport, painting the raw fields would draw
  // lines the box was never sized for, straight off the bottom of it. The
  // colour split moves to an index for the same reason: one list, read once.
  const { body, goldFrom } = hoverCardBody(card, viewportH);
  body.forEach((line, i) => {
    ctx.fillStyle = i < goldFrom ? PALETTE.BONE : PALETTE.GOLD;
    ctx.fillText(fitText(ctx, line, w - CARD_PAD * 2), x + CARD_PAD, cursor);
    cursor += CARD_LINE_H;
  });

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Controls
//
// TAKING THE PRECEDENT `fitText` ALREADY SET ABOVE (see its note at the top of
// this section of the file): the three-line helpers that existed once per panel
// keep their private copies, and every panel added after this file existed takes
// its version from here. The reason is the same one and it is worth restating
// because a control is louder than a truncation: two panels that disagree about
// what a BUTTON looks like teach a player that one of them is not pressable.
// ---------------------------------------------------------------------------

/**
 * The face every button in this client wears. `bold 10px`, matching the meta
 * text in ui/partypanel.ts, ui/turncards.ts and ui/caselog.ts.
 *
 * Exported so a caller that needs to measure a label BEFORE handing it to
 * `drawButton` — a sizer deciding whether two buttons fit side by side — can
 * measure against the face the button will actually use, rather than against
 * whatever the last painter left on the context.
 */
export const FONT_BUTTON = 'bold 10px ui-monospace, Consolas, monospace';

export type ButtonOptions = {
  /** Border and label colour. The plate is always INK. */
  readonly ink: string;
  /** Override the face. Defaults to `FONT_BUTTON`; almost nothing should. */
  readonly font?: string;
};

/**
 * A button: an INK plate, a 1px border on four sides, and a centred label.
 *
 * LIFTED VERBATIM from the private copy in ui/partypanel.ts (its ACCEPT /
 * DECLINE / `!` control), which keeps its own — changing a working file to
 * import a helper is churn, and that file is the one place this shape has
 * already been proven against a real click. What is NOT churn is a second panel
 * inventing a second look, so the class picker's confirm button and the
 * character sheet's close button both come from here.
 *
 * FOUR 1px `fillRect`s RATHER THAN A `strokeRect`: a stroke is centred on the
 * path, so a 1px stroke at an integer coordinate lands half a pixel either side
 * of it and the backbuffer's nearest-neighbour magnification turns that into a
 * border that is two pixels thick on some edges and invisible on others.
 *
 * `save`/`restore` around the text because it sets `font`, `textAlign` and
 * `fillStyle`; the four rects before it are deliberately outside, since the
 * caller has already had to set `fillStyle` for its own plate anyway.
 */
export function drawButton(
  ctx: CanvasRenderingContext2D,
  rect: PanelRect,
  label: string,
  opts: ButtonOptions,
): void {
  if (rect.w <= 0 || rect.h <= 0) return;
  ctx.fillStyle = PALETTE.INK;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.fillStyle = opts.ink;
  ctx.fillRect(rect.x, rect.y, rect.w, 1);
  ctx.fillRect(rect.x, rect.y + rect.h - 1, rect.w, 1);
  ctx.fillRect(rect.x, rect.y, 1, rect.h);
  ctx.fillRect(rect.x + rect.w - 1, rect.y, 1, rect.h);
  ctx.save();
  ctx.font = opts.font ?? FONT_BUTTON;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = opts.ink;
  ctx.fillText(fitText(ctx, label, rect.w - 6), rect.x + rect.w / 2, rect.y + rect.h / 2);
  ctx.restore();
}

/**
 * The dimmer a MODAL sits on: the whole viewport, INK, at 70%.
 *
 * ═══ THE save/restore IS INSIDE THIS FUNCTION AND IS NOT OPTIONAL ═══
 * `globalAlpha` is context state, not a parameter, so an unwrapped assignment
 * leaks to EVERY painter that runs later in the same frame — the hotbar, the
 * turn cards, the map itself. It presents as translucent sprites across the
 * whole screen, which is diagnosed as a broken PNG or a bad manifest long before
 * anybody looks for a missing `restore`. ui/turncards.ts:786-790 records the
 * identical trap for `ctx.filter`, where a leaked greyscale greys the world.
 *
 * Putting the pairing HERE rather than asking each caller to remember it means
 * the trap can be sprung at most once, in one file, under one test.
 *
 * 70% rather than opaque: a modal that hides the map entirely reads as a scene
 * change, and a player who cannot see their own body behind the chooser has no
 * idea the game is still there. 70% is enough that no tile is legible enough to
 * be acted on and enough that the world is visibly still underneath.
 */
export function drawScrim(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  if (w <= 0 || h <= 0) return;
  ctx.save();
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = PALETTE.INK;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/** Which edge a reduced blit sits against when it is shorter than its box. */
export const BlitAnchor = {
  /** Feet on the floor of the box. A body is identified by its silhouette. */
  Bottom: 'bottom',
  /** Centred both ways. A face, an icon — anything with no ground line. */
  Centre: 'centre',
} as const;
export type BlitAnchor = (typeof BlitAnchor)[keyof typeof BlitAnchor];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A SPRITE INTO A BOX TOO SMALL FOR IT — SHRUNK BY A WHOLE FACTOR, NEVER CUT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three surfaces solved this by CROPPING: the party pane took the bottom 24x32
 * of a token, the class picker centre-cropped a portrait into a narrow card,
 * and the turn card did the same into 32x32. All three were reported as the
 * character being cut off, and they are the same bug three times — a 64px face
 * cropped into a 32px box is a nose.
 *
 * ═══ ONLY EXACT INTEGER DIVISION, WHICH IS WHY THIS IS SAFE ═══
 * `imageSmoothingEnabled` is false everywhere this client draws, so scaling is
 * nearest-neighbour. An EXACT divisor samples on a regular lattice — every
 * output pixel is one input pixel, uniformly — and stays sharp. A fractional
 * one drops rows unevenly and looks torn. So this searches 1, 2, … for the
 * first `d` that divides BOTH dimensions and fits, and refuses if none does.
 *
 * REFUSING IS THE POINT. Returning false hands the caller back its own
 * fallback — initials, a letter plate — which is a worse picture and an honest
 * one. Cropping would look almost right, which is how this survived in three
 * places at once.
 *
 * ═══ THE CAP IS THE CALLER'S ═══
 * `maxReduction` defaults to 2 because a 64x64 face at d=4 is a 16px smudge,
 * and a card short enough to need that should show letters instead. The talent
 * icons genuinely want 4 (a 64x64 icon into a 16px chip) and pass it.
 *
 * Two ratios already ship — the hotbar halves and the character sheet quarters
 * — but both scale to their box unconditionally rather than checking a divisor.
 * The check is new policy here, not a restatement of theirs.
 */
export function blitReduced(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  id: string,
  box: PanelRect,
  anchor: BlitAnchor = BlitAnchor.Centre,
  maxReduction = 2,
): boolean {
  if (box.w <= 0 || box.h <= 0) return false;
  const sprite = sprites.sprite(id);
  if (sprite === undefined) return false;

  for (let d = 1; d <= maxReduction; d += 1) {
    if (sprite.w % d !== 0 || sprite.h % d !== 0) continue;
    const w = sprite.w / d;
    const h = sprite.h / d;
    if (w > box.w || h > box.h) continue;
    // THE FIVE-ARGUMENT FORM. There is no source rectangle, so there is no
    // crop — that is the whole contract, enforced by the call shape itself.
    ctx.drawImage(
      sprite.image,
      box.x + Math.floor((box.w - w) / 2),
      anchor === BlitAnchor.Bottom ? box.y + (box.h - h) : box.y + Math.floor((box.h - h) / 2),
      w,
      h,
    );
    return true;
  }
  return false;
}
