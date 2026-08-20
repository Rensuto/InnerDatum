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
 * ═══ IT CLAMPS RATHER THAN FLIPS ═══
 * A card that flipped sides near an edge would move under the pointer while the
 * pointer stood still, which reads as flicker. Clamping keeps it still: it slides
 * along the edge instead, and the pointer never loses the thing it is over.
 */
export type HoverCard = {
  readonly title: string;
  /** One line under the title — cost, slot, rank. Absent when there is none. */
  readonly meta?: string;
  /** The body. Already wrapped by the caller, which owns the width it wants. */
  readonly lines: readonly string[];
  /** A second block, drawn in gold — "what one more point buys". */
  readonly nextLines?: readonly string[];
};

const CARD_PAD = 6;
const CARD_LINE_H = 12;
const CARD_GAP = 10;

/** How wide a card wants to be, so a caller can wrap its prose to fit. */
export function hoverCardWidth(ctx: CanvasRenderingContext2D, card: HoverCard): number {
  ctx.font = FONT_BUTTON;
  let widest = ctx.measureText(card.title).width;
  ctx.font = '10px ui-monospace, Consolas, monospace';
  for (const line of [card.meta ?? '', ...card.lines, ...(card.nextLines ?? [])]) {
    widest = Math.max(widest, ctx.measureText(line).width);
  }
  return Math.ceil(widest) + CARD_PAD * 2;
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
  const body = [...card.lines, ...(card.nextLines ?? [])];
  const rows = 1 + (card.meta === undefined ? 0 : 1) + body.length;
  const w = Math.min(hoverCardWidth(ctx, card), Math.max(80, viewportW - CARD_GAP * 2));
  const h = CARD_PAD * 2 + rows * CARD_LINE_H;

  // Above the pointer by preference — a card under the cursor covers the next
  // thing the player is about to point at.
  const x = Math.min(Math.max(CARD_GAP, px - Math.floor(w / 2)), viewportW - w - CARD_GAP);
  // ABOVE THE POINTER BY PREFERENCE, below it when there is no room above, and
  // clamped either way — a card that ran off the bottom would be a description
  // the player can see the top two lines of.
  const above = py - h - CARD_GAP;
  const y = Math.min(
    Math.max(CARD_GAP, above < CARD_GAP ? py + CARD_GAP : above),
    Math.max(CARD_GAP, viewportH - h - CARD_GAP),
  );

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
  ctx.fillStyle = PALETTE.BONE;
  for (const line of card.lines) {
    ctx.fillText(line, x + CARD_PAD, cursor);
    cursor += CARD_LINE_H;
  }
  ctx.fillStyle = PALETTE.GOLD;
  for (const line of card.nextLines ?? []) {
    ctx.fillText(line, x + CARD_PAD, cursor);
    cursor += CARD_LINE_H;
  }
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
