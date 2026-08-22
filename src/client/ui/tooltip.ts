/**
 * THE HOVER CARD: point at something, find out what it is and whether you can
 * hit it.
 *
 * ===========================================================================
 * IT PAINTS A SERVER ANSWER AND COMPUTES NOTHING
 * ===========================================================================
 * Every number on this card arrives in an `InspectView` off the wire. The client
 * is FORBIDDEN from importing shared/checkhit, shared/scale and shared/energy
 * (eslint blocks it), so it could not work out a hit chance even if it wanted
 * to — and a second copy of a combat formula in the browser diverges the first
 * time either side is touched, which reads to the player as rigged dice. The
 * type itself lives in shared/protocol.ts rather than in src/server/view/
 * inspect.ts where it is produced, because a browser file may never import from
 * under src/server/ and this painter has to name what it is handed.
 *
 * ===========================================================================
 * THE BOX IS SIZED WITHOUT MEASURING, LIKE THE TOKEN MENU
 * ===========================================================================
 * `tooltipRect` is exported and takes no context. That is what makes the layout
 * testable at all: vitest runs in `node` with deliberately no jsdom, so a rect
 * that needed `ctx.measureText` could only be checked by a human squinting at
 * the screen. It costs nothing here — unlike the menu, the tooltip is never
 * clicked, so nothing depends on the box being pixel-exact. The width is an
 * ESTIMATE from character counts in a fixed-advance font, and every string the
 * painter draws is run through `fitText` against the REAL inner width, so an
 * estimate that is a few pixels tight costs an ellipsis and never an overflow.
 *
 * ===========================================================================
 * SAVE/RESTORE IS NOT OPTIONAL
 * ===========================================================================
 * Canvas state leaks between painters, and this one runs from `paintHud` in the
 * middle of a frame. ui/turncards.ts sets `ctx.filter` and warns what a leaked
 * one looks like: not a missing restore, but a BROKEN PNG — every sprite drawn
 * afterwards comes out grey and the search starts in the asset pipeline. So the
 * whole draw is wrapped, and `imageSmoothingEnabled`, `textAlign` and
 * `textBaseline` are re-asserted on entry like every sibling in this directory
 * rather than inherited from whoever drew last.
 *
 * ===========================================================================
 * WHERE IT SITS, AND WHAT IT IS ALLOWED TO COVER
 * ===========================================================================
 * Anchored to the POINTER, not to the actor's tile: `lastCamX`/`lastCamY` are
 * written at the very end of `draw()` and there is no exported tile->screen
 * transform, so a tile-anchored tooltip would need a second copy of the camera
 * maths. It opens down-and-right and FLIPS rather than slides at an edge, which
 * is contextmenu.ts's algorithm verbatim — a card that slid would drift away
 * from the thing it describes.
 *
 * main.ts draws it after the respawn plate and immediately BEFORE the combat
 * banner, so the banner and the token menu both still win: an incidental hover
 * is the weakest claim on that screen space of the three.
 */

import { PALETTE } from '../render/canvas.ts';
import {
  drawHeader,
  drawPanel,
  fitText,
  HEADER_H,
  PANEL_PAD,
  panelInner,
  PanelSkin,
} from './panel.ts';
import type { InspectView } from '../../shared/protocol.ts';
import type { SpriteSource } from '../render/assets.ts';
import type { PanelRect } from './panel.ts';

/**
 * Advance of one glyph in the 10px monospace this file draws with — the same
 * estimate, and the same six pixels, contextmenu.ts uses and for the same
 * reason. See the header: it decides the width and nothing else.
 */
const CHAR_W = 6;
/** One text row. 10px glyphs with 2px of leading, matching the Case Log. */
const ROW_H = 12;
/**
 * Blank characters budgeted between a label and its right-aligned value, so the
 * two do not touch at the widest line. Presentation only; the painter also
 * shortens the label against the value's MEASURED width at draw time.
 */
const GAP_CHARS = 3;
const MIN_W = 96;
const MAX_W = 184;

/**
 * The chrome the content box loses on each side.
 *
 * MIRRORS `panelInner`'s own inset, which is module-private in panel.ts. A drift
 * between the two is survivable by construction — the painter lays text out
 * inside the real `panelInner` result and clips to it — so this is a sizing
 * estimate, not a second source of truth about the skin.
 */
const INSET = PANEL_PAD + 3;

const FONT_BODY = '10px ui-monospace, Consolas, monospace';
/**
 * Emphasis AND the header wear the same bold face. `InspectRow.emphasis` is
 * reserved for the number that decides whether to commit — the hit chance, and a
 * threat that can kill you this turn — so it is the one thing on the card
 * allowed to shout as loudly as the name.
 */
const FONT_BOLD = 'bold 10px ui-monospace, Consolas, monospace';

export type TooltipDrawOptions = {
  readonly ctx: CanvasRenderingContext2D;
  readonly sprites: SpriteSource;
  readonly view: InspectView;
  /** The pointer, in LOGICAL backbuffer pixels. */
  readonly px: number;
  readonly py: number;
  readonly viewportW: number;
  readonly viewportH: number;
};

/** One laid-out line: a label on the left, a value on the right. */
type TipLine = {
  readonly label: string;
  readonly value: string;
  readonly emphasis: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * The body lines, top down — the ONE place the card's contents are decided, so
 * the sizer and the painter cannot disagree about how many there are.
 *
 * The first line spends `kind` as its label rather than the word "hp": the kind
 * is a fact the card would otherwise drop entirely, and pairing it with the
 * health reads as "monster, 17/17" without costing a row.
 *
 * `effects` is deliberately NOT drawn. inspect.ts returns `[]` for it today and
 * the gateway folds nothing in, so a badge row would be a permanently empty
 * strip of chrome. The natural home for populating it is the gateway
 * composition, beside `blockedReason`; when it starts carrying ids, the row
 * belongs here and the height arithmetic below is where it lands.
 */
function tipLines(view: InspectView): readonly TipLine[] {
  return [
    // ═══ `ceil`, THE SAME ROUNDING partypanel.ts AND turncards.ts USE ═══
    // `InspectView.hp` is the raw server-side number, and since the scheduler
    // moved onto the real damage pipeline that number is routinely fractional
    // (`dam * pres - armour + dam * (1 - pres)` does not land on integers).
    // Printed raw this row read "14.000000000000002/25". Rounding differently
    // from the party panel would be worse than not rounding: one body would
    // read 14 in one widget and 15 in another, and a player would reasonably
    // conclude one of them is lying.
    {
      label: view.kind,
      value: `${Math.max(0, Math.ceil(view.hp))}/${view.maxHp}`,
      emphasis: false,
    },
    ...view.rows.map((row) => ({
      label: row.label,
      value: row.value,
      emphasis: row.emphasis === true,
    })),
  ];
}

/**
 * The card's box, from the strings alone. No context, no measurement.
 *
 * ONE ROW PER LINE, PLUS ONE FOR THE REFUSAL WHEN THERE IS ONE. The refusal is
 * a single line rather than a wrapped paragraph on purpose: the reasons are
 * short authored sentences ("too close: needs 3 tiles"), and a wrapped block
 * would make the box's height depend on pixel measurement, which is exactly what
 * this function exists not to do. A pathologically long reason is trimmed with an
 * ellipsis by the painter.
 */
export function tooltipRect(
  view: InspectView,
  px: number,
  py: number,
  viewportW: number,
  viewportH: number,
): PanelRect {
  const lines = tipLines(view);
  const blocked = view.blockedReason;

  let widest = view.name.length;
  for (const line of lines) {
    widest = Math.max(widest, line.label.length + GAP_CHARS + line.value.length);
  }
  if (blocked !== undefined) widest = Math.max(widest, blocked.length);

  const w = clamp(widest * CHAR_W + INSET * 2, MIN_W, MAX_W);
  const rows = lines.length + (blocked === undefined ? 0 : 1);
  const h = HEADER_H + INSET * 2 + rows * ROW_H;

  // Opens DOWN AND RIGHT of the pointer, and FLIPS rather than slides when that
  // would run off the edge — contextmenu.ts's algorithm, unchanged. A card that
  // slid along the bottom of the screen would end up describing a token several
  // tiles away from the one it is anchored to.
  const x = px + w <= viewportW ? px : Math.max(0, px - w);
  const y = py + h <= viewportH ? py : Math.max(0, py - h);
  return {
    x: clamp(x, 0, Math.max(0, viewportW - w)),
    y: clamp(y, 0, Math.max(0, viewportH - h)),
    w,
    h,
  };
}

/**
 * Paint the hover card at the pointer.
 *
 * The caller decides WHETHER there is anything to draw: a `view` of null — the
 * server's single answer to "no such actor", "you cannot see it" and "that
 * monster is dead" — never reaches this function.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE OTHER CARD: WHAT IS LYING ON A TILE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ A SIBLING RATHER THAN A VARIANT OF `InspectView` ═══
 * The actor card's first row is `kind: hp/maxHp` and it is followed by effect
 * badges and a blocked reason. A coat has none of those, and giving one a
 * synthesised `hp: 0` would put "0/0" under its name on a card whose whole job
 * is to be read at a glance. The two cards show genuinely different things, so
 * they are two functions over the same panel helpers rather than one function
 * with a discriminant and four branches inside every loop.
 *
 * ═══ WHY THE FLOOR NEEDED A CARD AT ALL ═══
 * The floor marker carries a TIER COLOUR and nothing else, so a pile was a
 * coloured dot. The only way to learn what a dot was is to walk onto it — and a
 * pickup COSTS A TURN, so "walk over and find out" charges a player a turn to
 * ask a question the `ground` frame can answer for free.
 *
 * It also completes the argument `GroundMsg` already makes for being broadcast:
 * *"One floor, one frame, everybody looking at the same thing"*, so the party
 * can say "you take it, I've got a coat". They could not say that about a dot.
 */
export type LootTipItem = {
  readonly name: string;
  readonly tier: string;
};

export type LootTipOptions = {
  readonly ctx: CanvasRenderingContext2D;
  readonly sprites: SpriteSource;
  readonly items: readonly LootTipItem[];
  /** True when the viewer is standing on this tile — it changes the hint only. */
  readonly underfoot: boolean;
  /** The pointer, in LOGICAL backbuffer pixels. */
  readonly px: number;
  readonly py: number;
  readonly viewportW: number;
  readonly viewportH: number;
};

/**
 * HOW MANY NAMES A CARD WILL LIST BEFORE IT COUNTS THE REST.
 *
 * A tile can legally hold any number of things. Four names plus "+3 more" is a
 * card a player reads; eleven names is a wall that covers the fight underneath
 * it, which is the failure the actor card's own MAX_W guard exists to avoid.
 */
const LOOT_MAX_ROWS = 4;

/** The hint under the names. The whole point of the card for a new player. */
function lootHint(underfoot: boolean): string {
  return underfoot ? 'click to pick up' : 'walk here to take it';
}

/**
 * The card's box, from the strings alone. No context, no measurement — the same
 * rule `tooltipRect` states and for the same reason.
 */
export function lootTipRect(
  items: readonly LootTipItem[],
  underfoot: boolean,
  px: number,
  py: number,
  viewportW: number,
  viewportH: number,
): PanelRect {
  const shown = Math.min(items.length, LOOT_MAX_ROWS);
  const overflow = items.length - shown;
  const names = items.slice(0, shown).map((item) => item.name);
  if (overflow > 0) names.push(`+${String(overflow)} more`);
  const hint = lootHint(underfoot);

  const widest = Math.max(HEADER_CHARS, hint.length, ...names.map((name) => name.length));
  const w = Math.min(MAX_W, Math.max(MIN_W, widest * CHAR_W + INSET * 2));
  // One row per name, one for the hint, plus the header.
  const h = HEADER_H + INSET * 2 + (names.length + 1) * ROW_H;

  // FLIPPED TO THE OTHER SIDE OF THE POINTER WHEN IT WOULD OVERFLOW, which is
  // `tooltipRect`s rule character for character (:198-199). Two cards that place
  // themselves differently at a screen edge read as two different features.
  const x = px + w <= viewportW ? px : Math.max(0, px - w);
  const y = py + h <= viewportH ? py : Math.max(0, py - h);
  return { x, y, w, h };
}

/** The word the header uses. Kept short so the box does not open on it. */
const HEADER_CHARS = 12;

export function drawLootTip(opts: LootTipOptions): void {
  const { ctx, sprites, items, underfoot, px, py, viewportW, viewportH } = opts;
  if (items.length === 0) return;
  const rect = lootTipRect(items, underfoot, px, py, viewportW, viewportH);

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  drawPanel(ctx, sprites, PanelSkin.Inset, rect);
  const headerBottom = drawHeader(ctx, sprites, 'On the floor', rect, FONT_BOLD);

  const inner = panelInner({
    x: rect.x,
    y: headerBottom,
    w: rect.w,
    h: rect.y + rect.h - headerBottom,
  });
  if (inner.w <= 0 || inner.h <= 0) {
    ctx.restore();
    return;
  }

  const shown = Math.min(items.length, LOOT_MAX_ROWS);
  const overflow = items.length - shown;
  let y = inner.y + ROW_H / 2;

  ctx.font = FONT_BODY;
  for (const item of items.slice(0, shown)) {
    ctx.fillStyle = PALETTE.PARCHMENT;
    ctx.fillText(fitText(ctx, item.name, inner.w), inner.x, y);
    y += ROW_H;
  }
  if (overflow > 0) {
    // COUNTED, NEVER SILENTLY DROPPED — ui/caselog.ts's rule that a surface which
    // has stopped showing everything must not make the reader infer it.
    ctx.fillStyle = PALETTE.BONE;
    ctx.fillText(fitText(ctx, `+${String(overflow)} more`, inner.w), inner.x, y);
    y += ROW_H;
  }

  // THE HINT, IN THE COLOUR THAT MEANS "YOU CAN DO THIS". Gold while the thing
  // is at your feet and the click will work; plain while it is a walk away.
  ctx.fillStyle = underfoot ? PALETTE.GOLD : PALETTE.BONE;
  ctx.fillText(fitText(ctx, lootHint(underfoot), inner.w), inner.x, y);

  ctx.restore();
}

export function drawTooltip(opts: TooltipDrawOptions): void {
  const { ctx, sprites, view, px, py, viewportW, viewportH } = opts;
  const rect = tooltipRect(view, px, py, viewportW, viewportH);

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  drawPanel(ctx, sprites, PanelSkin.Inset, rect);
  // The NAME is the header and never a row: it is a nickname or an authored
  // monster name, which is to say hostile input, and a heading cannot be
  // mistaken for something to click.
  const headerBottom = drawHeader(ctx, sprites, view.name, rect, FONT_BOLD);

  const inner = panelInner({
    x: rect.x,
    y: headerBottom,
    w: rect.w,
    h: rect.y + rect.h - headerBottom,
  });
  if (inner.w <= 0 || inner.h <= 0) {
    ctx.restore();
    return;
  }

  const right = inner.x + inner.w;
  let y = inner.y + ROW_H / 2;

  for (const line of tipLines(view)) {
    // `fitText` measures, so the font has to be live BEFORE it is called — it
    // takes the context rather than a font on purpose, and measuring against
    // whatever the last painter left behind is the bug that convention prevents.
    ctx.font = line.emphasis ? FONT_BOLD : FONT_BODY;
    const valueW = ctx.measureText(line.value).width;

    ctx.textAlign = 'left';
    ctx.fillStyle = line.emphasis ? PALETTE.GOLD : PALETTE.GREY_HI;
    ctx.fillText(fitText(ctx, line.label, inner.w - valueW - CHAR_W), inner.x, y);

    ctx.textAlign = 'right';
    ctx.fillStyle = line.emphasis ? PALETTE.GOLD : PALETTE.BONE;
    ctx.fillText(line.value, right, y);

    y += ROW_H;
  }

  const blocked = view.blockedReason;
  if (blocked !== undefined) {
    // ORANGE, not CRIMSON: crimson means exactly one thing in this palette —
    // hostiles are engaged — and it is spent by the combat banner and the ring
    // around the playfield and by nothing else. Not VIOLET_HI either; that is
    // the renderer's missing-asset colour, so a sentence drawn in it is
    // indistinguishable from a broken manifest.
    //
    // PRESENT MEANS REFUSED. The key is ABSENT when the attack would land — the
    // gateway builds it from a function that returns undefined and JSON.stringify
    // drops it — so this branch draws only when there is genuinely a reason.
    ctx.font = FONT_BODY;
    ctx.textAlign = 'left';
    ctx.fillStyle = PALETTE.ORANGE;
    ctx.fillText(fitText(ctx, blocked, inner.w), inner.x, y);
  }

  ctx.restore();
}
