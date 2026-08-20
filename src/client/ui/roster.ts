// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
//
// Inner Datum — the select screen: who are you tonight.

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
import type { CharacterRow } from '../../shared/protocol.ts';
import type { SpriteSource } from '../render/assets.ts';
import type { PanelRect } from './panel.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *              THE FIRST SCREEN OF THE GAME, AND THE ONLY ONE
 *                    A PLAYER SEES BEFORE THEY EXIST.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A ROW IS A CHARACTER, NOT A SAVE SLOT. The difference is what is on it: a slot
 * says "SAVE 3 — 14:22", a character says who they are, what they are, how far
 * along, and how much of the case file they have closed. Every field here
 * answers the one question this screen exists for — *"which of these do I want
 * to be tonight"* — and nothing that does not answer it is drawn.
 *
 * ═══ IT BORROWS THE CLASS PICKER'S BONES ON PURPOSE ═══
 * Same scrim, same `PanelSkin.CaseFile`, same header, same card geometry, same
 * `drawButton`. These two screens are seen back to back — pick a character,
 * then (if it is new) pick a class — and a player who crosses that seam should
 * not feel the client change hands. It is also the reason the shortcut digits
 * are drawn in the same corner at the same size: the gesture that picked a class
 * five seconds ago picks a character here.
 *
 * ═══ AN UNPLAYABLE ROW IS DRAWN, GREYED, AND SAYS WHY ═══
 * `ui/contextmenu.ts` already argues this for menu rows and the argument is
 * sharper here: a roster that silently omits a character whose file this build
 * cannot read tells its player the character was DELETED. What they will do
 * about that is make a new one, play it, and let the autosave write over the
 * directory they were trying to recover from. Drawn-and-refused costs one line
 * of grey text and prevents that entirely.
 */

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const ROSTER_MAX_W = 640;
const ROSTER_MAX_H = 460;
const ROSTER_MARGIN = 12;

const TITLE = 'YOUR CHARACTERS';

/**
 * THE HINT LINE, AND IT NAMES THE VERB RATHER THAN THE KEY.
 *
 * A first-time player has never seen this screen and does not know that a row is
 * clickable. "Choose a character" is the instruction; the digits drawn on each
 * card are the shortcut, and they teach themselves once the sentence has said
 * what the cards are for.
 */
const HINT = 'Choose a character, or start a new one.';
const HINT_H = 14;

const CARD_H = 46;
const CARD_GAP = 4;
const BUTTON_H = 22;
const BUTTON_W = 132;

/** The tallest a row list may get before it stops growing and starts scrolling. */
const LIST_PAD = 2;

export const RosterHitKind = {
  Row: 'row',
  Create: 'create',
  Play: 'play',
} as const;
export type RosterHitKind = (typeof RosterHitKind)[keyof typeof RosterHitKind];

export type RosterHit =
  | { readonly kind: typeof RosterHitKind.Row; readonly index: number }
  | { readonly kind: typeof RosterHitKind.Create }
  | { readonly kind: typeof RosterHitKind.Play };

/**
 * WHERE THE MODAL GOES. Never null, for the same reason `classPickerRect` is
 * never null: a player who has not chosen a character cannot play, so a viewport
 * too small for the preferred size gets a smaller modal rather than none. An
 * empty screen with no explanation is the one outcome this must never produce.
 */
export function rosterRect(width: number, height: number): PanelRect {
  const wantW = Math.min(ROSTER_MAX_W, width - ROSTER_MARGIN * 2);
  const wantH = Math.min(ROSTER_MAX_H, height - ROSTER_MARGIN * 2);
  const w = Math.max(0, Math.min(wantW, width));
  const h = Math.max(0, Math.min(wantH, height));
  return {
    x: Math.round((width - w) / 2),
    y: Math.round((height - h) / 2),
    w,
    h,
  };
}

type Geometry = {
  readonly hint: PanelRect;
  readonly rows: readonly PanelRect[];
  readonly create: PanelRect;
  readonly play: PanelRect;
};

function geometryFor(count: number, rect: PanelRect): Geometry {
  const innerX = rect.x + PANEL_PAD;
  const innerW = Math.max(0, rect.w - PANEL_PAD * 2);
  const top = rect.y + HEADER_H + PANEL_PAD;

  const hint: PanelRect = { x: innerX, y: top, w: innerW, h: HINT_H };

  // THE BUTTONS ARE PLACED FIRST, FROM THE BOTTOM, and the list gets what is
  // left. Doing it the other way round — list first, buttons after — puts the
  // only two controls on the screen off the bottom edge the moment somebody has
  // more characters than fit, which is exactly when they most need them.
  const buttonY = rect.y + rect.h - PANEL_PAD - BUTTON_H;
  const create: PanelRect = { x: innerX, y: buttonY, w: BUTTON_W, h: BUTTON_H };
  const play: PanelRect = {
    x: innerX + innerW - BUTTON_W,
    y: buttonY,
    w: BUTTON_W,
    h: BUTTON_H,
  };

  const listTop = hint.y + HINT_H + LIST_PAD;
  const listBottom = buttonY - PANEL_PAD;
  const rows: PanelRect[] = [];
  for (let i = 0; i < count; i += 1) {
    const y = listTop + i * (CARD_H + CARD_GAP);
    // A CARD THAT WOULD CROSS THE BUTTONS IS NOT DRAWN AT ALL rather than drawn
    // clipped: half a character is a row somebody clicks by accident, and the
    // clip on the panel would hide the fact that it is half.
    if (y + CARD_H > listBottom) break;
    rows.push({ x: innerX, y, w: innerW, h: CARD_H });
  }

  return { hint, rows, create, play };
}

/**
 * The card rectangles, for a caller that needs to know where the rows landed
 * without drawing them. Exported so hit testing and the draw agree by
 * construction rather than by two people keeping two copies of the arithmetic.
 */
export function rosterRows(count: number, rect: PanelRect): readonly PanelRect[] {
  return geometryFor(count, rect).rows;
}

/** How many rows this rect can show. The rest are real and simply off-screen. */
export function rosterVisibleCount(count: number, rect: PanelRect): number {
  return geometryFor(count, rect).rows.length;
}

function inside(rect: PanelRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

/**
 * What is under the pointer, or null.
 *
 * `canCreate` GATES THE HIT AND NOT JUST THE PAINT. A button drawn greyed that
 * still answers to a click is worse than one that is not there — it tells the
 * player the cap is not real and then does nothing, twice.
 */
export function rosterHitAt(
  count: number,
  rect: PanelRect,
  canCreate: boolean,
  x: number,
  y: number,
): RosterHit | null {
  const geometry = geometryFor(count, rect);
  if (canCreate && inside(geometry.create, x, y)) return { kind: RosterHitKind.Create };
  if (inside(geometry.play, x, y)) return { kind: RosterHitKind.Play };
  for (let i = 0; i < geometry.rows.length; i += 1) {
    const row = geometry.rows[i];
    if (row !== undefined && inside(row, x, y)) return { kind: RosterHitKind.Row, index: i };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------

const FONT_NAME = 'bold 12px ui-monospace, Consolas, monospace';
const FONT_BODY = '10px ui-monospace, Consolas, monospace';
const FONT_META = 'bold 10px ui-monospace, Consolas, monospace';

/**
 * "3 of 27 · 14 days ago" — the two facts a returning player uses to tell their
 * own characters apart, and the second one is the reason this is not just a
 * level number. Somebody with two level-9 Watchmen knows which is which by when
 * they last played it.
 */
function agoWords(iso: string | undefined, nowMs: number): string {
  if (iso === undefined || iso === '') return 'never played';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'never played';
  const mins = Math.max(0, Math.floor((nowMs - then) / 60_000));
  if (mins < 2) return 'just now';
  if (mins < 60) return `${String(mins)} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${String(hours)} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${String(days)} days ago`;
}

function drawRow(
  ctx: CanvasRenderingContext2D,
  row: CharacterRow,
  rect: PanelRect,
  index: number,
  cases: number,
  nowMs: number,
  selected: boolean,
  hovered: boolean,
): void {
  const dim = !row.playable;

  ctx.fillStyle = selected ? PALETTE.SLATE : hovered ? PALETTE.PANEL : PALETTE.VOID;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

  // THE SELECTION IS AN EDGE, NOT A FILL, so a selected row and a hovered row
  // cannot be confused at a glance — the fill says "the pointer is here" and
  // only the edge says "this is the one that will be played".
  ctx.strokeStyle = selected ? PALETTE.GOLD : PALETTE.SLATE;
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);

  const padX = 8;
  const textX = rect.x + padX;
  const rightX = rect.x + rect.w - padX;

  // THE SHORTCUT DIGIT, in the same corner and the same size the class picker
  // puts it, because the gesture is the same gesture.
  ctx.font = FONT_META;
  ctx.textAlign = 'right';
  ctx.fillStyle = dim ? PALETTE.GREY : PALETTE.GREY_HI;
  ctx.fillText(String(index + 1), rightX, rect.y + 12);

  ctx.textAlign = 'left';
  ctx.font = FONT_NAME;
  ctx.fillStyle = dim ? PALETTE.GREY : PALETTE.PARCHMENT;
  ctx.fillText(fitText(ctx, row.name, rect.w - padX * 2 - 16), textX, rect.y + 13);

  ctx.font = FONT_BODY;
  ctx.fillStyle = dim ? PALETTE.GREY : PALETTE.SILVER;
  // A CLASS THIS BUILD NO LONGER HAS PRINTS NOTHING RATHER THAN AN ID. The save
  // loader takes the same posture one layer down about a dangling class, and a
  // row reading `watchman` has leaked an id at the player.
  const what = row.className ?? 'unrecorded';
  ctx.fillText(
    fitText(ctx, `Level ${String(row.level)} · ${what}`, rect.w - padX * 2),
    textX,
    rect.y + 27,
  );

  if (dim) {
    // ═══ WHY IT CANNOT BE PLAYED, IN WORDS, ON THE ROW ═══
    // The refusal is a persist-layer outcome (`corrupt`, `too_new`) and it is
    // printed rather than translated: a player who reports "it says too_new" has
    // handed a maintainer the exact branch, which a friendlier sentence would
    // have thrown away.
    ctx.fillStyle = PALETTE.CRIMSON;
    ctx.fillText(
      fitText(
        ctx,
        `Cannot be opened by this build (${row.refusal ?? 'unreadable'})`,
        rect.w - padX * 2,
      ),
      textX,
      rect.y + 39,
    );
    return;
  }

  ctx.fillStyle = PALETTE.GREY_HI;
  ctx.fillText(
    fitText(
      ctx,
      `${String(row.filed)} of ${String(cases)} cases · ${String(row.money)} gold · ${agoWords(row.lastPlayed, nowMs)}`,
      rect.w - padX * 2,
    ),
    textX,
    rect.y + 39,
  );
}

export type RosterDrawOptions = {
  readonly ctx: CanvasRenderingContext2D;
  readonly sprites: SpriteSource;
  readonly rect: PanelRect;
  /** The server's list, in the server's order. Never sorted here. */
  readonly characters: readonly CharacterRow[];
  /** The size of a full case file, so a row can read "3 of 27". */
  readonly cases: number;
  readonly canCreate: boolean;
  readonly max: number;
  readonly selected: number | null;
  readonly hovered: number | null;
  /** Injected so "14 days ago" is testable and this module stays pure. */
  readonly nowMs: number;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE MENU PAINTS ITS OWN GROUND. IT IS NOT A PANEL ON TOP OF A GAME.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `drawScrim` is `globalAlpha = 0.7` over whatever is already on the canvas,
 * which is exactly right for a panel opened DURING play and exactly wrong for
 * this one. Reported with a screenshot: the select screen sitting over a lit
 * moor, party card and case log still drawn around it, because a player
 * changing character had been playing one and the client had not put it down.
 *
 * The client half of that is fixed where it belongs — `case 'roster'` now runs
 * the same teardown `welcome` does — and this is the other half: with nothing
 * behind it, a 70% scrim is 70% of nothing, and the screen would read as a
 * panel floating on a void rather than as the front door.
 *
 * ═══ DRAWN, NOT LOADED ═══
 * Every mark here is canvas work: a gradient, a vignette, and letterforms from
 * a system monospace. NO SPRITE, deliberately and permanently — the art in this
 * project is not committed and never will be, so a title that depended on an
 * image would render as a hole in a fresh clone. The one screen guaranteed to
 * be seen before anything else has to be the one that cannot fail to draw.
 */
function drawMenuBackdrop(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  if (w <= 0 || h <= 0) return;
  ctx.save();

  // OPAQUE, FLOOR TO CEILING. Not a wash over the last frame — the ground.
  const wash = ctx.createLinearGradient(0, 0, 0, h);
  wash.addColorStop(0, PALETTE.INK);
  wash.addColorStop(0.55, PALETTE.VOID);
  wash.addColorStop(1, PALETTE.INK);
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, w, h);

  /**
   * AND A VIGNETTE, WHICH IS THE ONLY REASON THE GRADIENT ABOVE IS NOT ENOUGH.
   * A flat field reads as a loading screen. Pulling the corners down toward INK
   * puts the eye on the middle third, which is where the character list is, and
   * costs one radial fill.
   */
  const cx = w / 2;
  const cy = h / 2;
  const glow = ctx.createRadialGradient(
    cx,
    cy,
    Math.min(w, h) * 0.12,
    cx,
    cy,
    Math.max(w, h) * 0.72,
  );
  glow.addColorStop(0, 'rgba(99, 64, 158, 0.16)');
  glow.addColorStop(0.6, 'rgba(10, 8, 19, 0)');
  glow.addColorStop(1, 'rgba(10, 8, 19, 0.72)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  ctx.restore();
}

/** Tracking, in pixels, between the title's letterforms. */
const WORDMARK_TRACK = 6;
const WORDMARK = 'INNER DATUM';
const FONT_WORDMARK = 'bold 26px ui-monospace, Consolas, monospace';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE GAME SAYS ITS OWN NAME, WHICH IT HAS NEVER DONE ANYWHERE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Inner Datum" appears in this repository only in source comments. A player
 * could finish an evening having never seen it, which is a strange thing for
 * the one screen every session starts on.
 *
 * ═══ TRACKED BY HAND, NOT BY `ctx.letterSpacing` ═══
 * The property is Chromium-only and recent, and this also has to survive the
 * canvas double in the client tests. Advancing per glyph is four lines and
 * works everywhere, and it is what gives the wordmark the spacing a monospace
 * face cannot express on its own.
 *
 * ═══ AND IT YIELDS RATHER THAN COLLIDES ═══
 * Drawn only when there is genuinely room above the panel. On a short window
 * the list is what matters and the title is what goes — a wordmark overlapping
 * the first character row would be worse than no wordmark at all.
 */
function drawWordmark(ctx: CanvasRenderingContext2D, rect: PanelRect, cases: number): void {
  const band = rect.y;
  if (band < 78) return;

  const centreX = rect.x + rect.w / 2;
  const baseline = rect.y - 46;

  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = FONT_WORDMARK;

  const glyphs = [...WORDMARK];
  let span = 0;
  for (const glyph of glyphs) span += ctx.measureText(glyph).width + WORDMARK_TRACK;
  span -= WORDMARK_TRACK;

  let pen = centreX - span / 2;
  ctx.fillStyle = PALETTE.PARCHMENT;
  for (const glyph of glyphs) {
    ctx.fillText(glyph, pen, baseline);
    pen += ctx.measureText(glyph).width + WORDMARK_TRACK;
  }

  // THE RULE UNDER IT, in the project's violet, no wider than the word itself.
  ctx.strokeStyle = PALETTE.VIOLET;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(centreX - span / 2), Math.round(baseline + 17) + 0.5);
  ctx.lineTo(Math.round(centreX + span / 2), Math.round(baseline + 17) + 0.5);
  ctx.stroke();

  /**
   * AND THE ONE FACT THE SCREEN CAN STATE THAT IS TRUE TONIGHT. `cases` is
   * already on this frame for the rows to read "3 of 27" — using it here costs
   * nothing and says what the game is in the game's own words, rather than a
   * genre label that would be true of a hundred other things.
   */
  ctx.font = FONT_BODY;
  ctx.fillStyle = PALETTE.GREY_HI;
  ctx.textAlign = 'center';
  ctx.fillText(`${String(cases)} rooms in the file.`, centreX, baseline + 31);

  ctx.restore();
}

export function drawRoster(options: RosterDrawOptions): void {
  const { ctx, sprites, rect, characters, cases, canCreate, max, selected, hovered, nowMs } =
    options;
  if (rect.w <= 0 || rect.h <= 0) return;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  drawMenuBackdrop(ctx, ctx.canvas.width, ctx.canvas.height);
  drawWordmark(ctx, rect, cases);
  drawPanel(ctx, sprites, PanelSkin.CaseFile, rect);
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();

  drawHeader(ctx, sprites, TITLE, rect, FONT_META);

  const geometry = geometryFor(characters.length, rect);

  ctx.font = FONT_BODY;
  ctx.fillStyle = PALETTE.GREY_HI;
  // AT THE CAP THE HINT SAYS SO. The `New character` button is about to be drawn
  // greyed and a button that has gone quiet without explanation reads as a bug.
  const hint = canCreate ? HINT : `You have all ${String(max)} characters this account may hold.`;
  ctx.fillText(fitText(ctx, hint, geometry.hint.w), geometry.hint.x, geometry.hint.y + HINT_H / 2);

  if (characters.length === 0) {
    // ═══ FIRST SIGHT OF THE ACCOUNT ═══
    // An empty list is the most common thing this screen will ever draw and it
    // must not look like a failure. The invitation goes where the rows would be.
    ctx.font = FONT_BODY;
    ctx.fillStyle = PALETTE.SILVER;
    ctx.fillText(
      fitText(ctx, 'Nobody here yet. Start a new character below.', rect.w - PANEL_PAD * 2),
      rect.x + PANEL_PAD,
      geometry.hint.y + HINT_H + 18,
    );
  }

  for (let i = 0; i < geometry.rows.length; i += 1) {
    const row = characters[i];
    const where = geometry.rows[i];
    if (row === undefined || where === undefined) continue;
    drawRow(ctx, row, where, i, cases, nowMs, selected === i, hovered === i);
  }

  drawButton(ctx, geometry.create, 'NEW CHARACTER', {
    ink: canCreate ? PALETTE.GOLD : PALETTE.GREY,
  });

  // DRAWN DISABLED-BUT-PRESENT when nothing is selected, never hidden — the same
  // argument the class picker's confirm button makes: a control that appears
  // only once you have done the thing teaches nothing about what to do.
  const chosen = selected === null ? undefined : characters[selected];
  const canPlay = chosen !== undefined && chosen.playable;
  drawButton(ctx, geometry.play, 'PLAY', { ink: canPlay ? PALETTE.GOLD : PALETTE.GREY });

  ctx.restore();
}
