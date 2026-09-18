/**
 * THE CONVERSATION WINDOW: a face, a line, and the things you may say back.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT IS `engine/dialogs/Chat.lua`, IN A ROOM WITH FIVE OTHER PEOPLE IN IT
 * ═══════════════════════════════════════════════════════════════════════════
 * Upstream's chat screen is a registered dialog: `engine/dialogs/Chat.lua:40`
 * titles it with the speaker's name, `:49` puts the spoken line in a `Textzone`,
 * `:50` puts the answers in a `VariableList` under it, `:55` rules a separator
 * between the two, `:58` hangs a 64x64 `ActorFrame` portrait off it and `:66`
 * gives the list the keyboard. Every one of those decisions is kept here.
 *
 * THE ONE THAT IS NOT is `engine/Game.lua:375-384` — registering a dialog makes
 * it the focus stack AND freezes the world, which is free for a single player
 * and is a catastrophe for six. So this is a DOCK PANEL clamped into
 * `panelBand`, with no scrim, and the world goes on without the talker. The
 * server parks their body instead (`parkForClassChoice` in server/net/gateway.ts,
 * and `client/main.ts`'s own note on the class chooser records what happened the
 * one time this client got it wrong).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE GEOMETRY FUNCTION. THE PAINTER, THE KEYBOARD AND THE POINTER READ IT.
 * ═══════════════════════════════════════════════════════════════════════════
 * `dialogueGeometry` lays out every box once and `drawDialogue`,
 * `dialogueHitAt` and the tests all call it. ui/classpicker.ts states the cost
 * of the other arrangement and it is the same cost here: a row drawn in one
 * place and pressed in another.
 *
 * AND EVERY STRING IS MEASURED AGAINST THE COLUMN IT IS DRAWN IN, never against
 * the panel. ui/caselog.ts:764-786 is the bug that rule comes from — a rule
 * drawn at `rect.x + stampW` and measured against `rect.w` hung past the border
 * by exactly the gutter's width, reported as happening "no matter what size",
 * because it is a number the FONT sets and the panel never does. So a row's
 * label gets its own rect, indented past the marker and the `[n]`, and that rect
 * is what `fitText` is handed.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HOST RULING, AS IT REACHES THE SCREEN — 2026-09-17, the author
 * ═══════════════════════════════════════════════════════════════════════════
 * *"the other players should be able to interact with npcs and have dialogue
 * interactions, but story driving conversations should only be applicable to
 * the host to protect their playthrough"*, and *"shop options and other
 * interactions will still occur through the dialogue interaction box"*.
 *
 * So EVERY player gets this window — opening a conversation is not a privilege —
 * and what the lead alone may do is answer a `story` row. This file draws a
 * story row a non-lead cannot give GREYED, WITH ITS REASON, rather than hiding
 * it. That is a deliberate exception to ui/verbs.ts's house rule that a row
 * which can never be enabled is a lie with a tooltip, and the exception is
 * earned rather than assumed: the answer IS available to the party, it simply is
 * not available through this player, and that is the fact the row exists to
 * teach. Hiding it would tell five people the conversation has three answers
 * when it has four — and the one who can give the fourth is in the same voice
 * channel. `DialogueOptionView` in shared/protocol.ts carries the same paragraph
 * from the wire's side.
 *
 * THE CLIENT DECIDES NONE OF IT. `enabled` and `reason` arrive on the frame and
 * are drawn. This file never asks who the lead is, never compares a scope to a
 * party row, and could not refuse an answer if it wanted to — the server rules
 * on every pick again when it lands.
 */

import { PALETTE } from '../render/canvas.ts';
import {
  BlitAnchor,
  HEADER_H,
  PANEL_PAD,
  PanelSkin,
  blitReduced,
  drawHeader,
  drawPanel,
  fitText,
  wrapClamped,
} from './panel.ts';
import type { DialogueOptionView, DialogueView } from '../../shared/protocol.ts';
import type { PanelRect } from './panel.ts';
import type { SpriteSource } from '../render/assets.ts';

// ---------------------------------------------------------------------------
// Geometry constants — every one derived, none free
// ---------------------------------------------------------------------------

/**
 * Advance of one glyph in the 10px monospace this file draws with. The same six
 * pixels ui/classpicker.ts, ui/tooltip.ts and ui/contextmenu.ts use — an
 * estimate that decides BOX sizes and nothing else. Every string is clamped by
 * `fitText` against the real column at paint time.
 */
const CHAR_W = 6;

/** Chrome lost on each side. Mirrors `panelInner`'s inset, as the picker does. */
const INSET = PANEL_PAD + 3;

/**
 * Upstream's own dialog width: `engine/Chat.lua:110` builds the chat screen with
 * `self.force_dialog_width or 500`, and `engine/dialogs/Chat.lua:40` passes the
 * same 500 into `Dialog.init` when it is not given one.
 *
 * It is the CONTENT width there, and ours is an outer rect, so the cap adds our
 * own two insets back. Writing 516 as a literal would be a number nobody could
 * check against anything.
 */
const UPSTREAM_DIALOG_W = 500;
export const DIALOGUE_MAX_W = UPSTREAM_DIALOG_W + INSET * 2;

/** Air between the window and the edges of the band it is docked in. */
export const DIALOGUE_MARGIN = 8;

/**
 * The portrait box. `chr_portrait_*` are 64x64 — the size
 * `engine/dialogs/Chat.lua:58` draws an `ActorFrame` at, the size
 * ui/classpicker.ts's `PORTRAIT_PX` already is, and the size `blitReduced` can
 * take a 48x64 body into whole at d=1.
 */
export const PORTRAIT_PX = 64;
/** Between the portrait and the column the line is drawn in. */
const PORTRAIT_GAP = 8;

/** One row of the spoken line, in the 10px face. */
const LINE_H = 12;
/**
 * How many rows the line gets, and it is a RESERVATION rather than a limit that
 * is expected to bite.
 *
 * At the cap the text column is 428 pixels, which is about seventy monospace
 * glyphs, so four rows hold roughly 280 characters. `LINE_MAX` in
 * server/content/townsfolk.ts is 56 — those strings were sized for the Margin's
 * 32-glyph lane and fit on one row here with room to spare. The four exist for
 * prose nobody has written yet, and `wrapClamped` marks the last row with an
 * ellipsis if it ever clamps, which is panel.ts's whole argument for preferring
 * a reservation big enough.
 */
export const LINE_ROWS = 4;

/** `engine/dialogs/Chat.lua:55` rules a separator between the line and the list. */
const SEPARATOR_H = 6;

/** One answer row. */
export const OPTION_ROW_H = 14;
/**
 * The second line a GREYED row grows, for the reason under it.
 *
 * ═══ IT IS A ROW OF ITS OWN BECAUSE THE NAME IS THE POINT ═══
 * The reason names the lead — "Only Dalt can answer for the party" — and a
 * Discord nickname is up to 32 characters, so the sentence can run to sixty.
 * Squeezed into a right-hand column beside the label it would ellipsise, and the
 * first thing lost is the name, which is the only part of the sentence that
 * tells the player what to do. So it gets the full width, under the label, in
 * the Margin's italic face.
 */
const REASON_ROW_H = 11;

/** The "5-8 of 8" line, when the list is taller than the band. */
const COUNT_H = 12;

/** The `▸` a selected row wears. A SHAPE — see `drawDialogue`. */
const MARK_W = CHAR_W;
/** `[n] ` — four glyphs, so a two-digit row would still be measured honestly. */
const PREFIX_W = CHAR_W * 4;

const FONT_NAME = 'bold 12px ui-monospace, Consolas, monospace';
const FONT_BODY = '10px ui-monospace, Consolas, monospace';
const FONT_SHORTCUT = 'bold 10px ui-monospace, Consolas, monospace';
/**
 * The reason's face, which is the Margin's (ui/caselog.ts's `fontMargin`).
 * A reason is narration ABOUT a row rather than a label ON one, and this client
 * already spends italic on exactly that distinction.
 */
const FONT_REASON = 'italic 10px ui-monospace, Consolas, monospace';
/** The letters a missing face falls back to. Non-violet — see `drawDialogue`. */
const FONT_FALLBACK = 'bold 18px ui-monospace, Consolas, monospace';

/**
 * The highest row a digit can reach.
 *
 * NINE BECAUSE THERE ARE NINE DIGIT KEYS, and a tenth row is reached with the
 * arrows or the mouse and draws no bracket at all. A `[10]` would be a shortcut
 * for a key nobody has.
 */
const MAX_DIGIT = 9;

/**
 * The keys this window kept, printed on it.
 *
 * ui/classpicker.ts:232-241's rule, and it applies here for the same reason: a
 * surface that takes the arrows, the digits and Enter owes the player a list of
 * what it took. It rides the header strip rather than a line of its own because
 * at the smallest viewport this client renders, a line of its own is most of an
 * answer row.
 *
 * THE DIGITS ARE COUNTED, NOT WRITTEN OUT — the picker's `pickerHint` note
 * records what a hard-coded `1-3` cost when a fourth class shipped.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THEY ARE COUNTED OFF THE ROWS THAT WERE PLACED, NOT OFF THE ANSWER LIST
 * ═══════════════════════════════════════════════════════════════════════════
 * This took `view.options.length` and it was a lie with a number in it,
 * measured: twenty answers on the 640x320 floor in combat place TWO rows, and
 * the strip read "1-9 pick". The rule the two halves have to keep is that the
 * printed range is the brackets a player can SEE — so the range is read off
 * `DialogueRow.digit`, which is the same field the painter draws and
 * `dialogueAnswerForDigit` resolves. A paged list says "3-4 pick", because 3 and
 * 4 are the numbers on the screen.
 *
 * NO `pick` CLAUSE AT ALL when nothing placed carries a digit — past the ninth
 * row there is no key, and printing a range nobody can press is the bug above
 * in its other direction.
 */
export function dialogueHint(rows: readonly DialogueRow[]): string {
  const digits = rows.flatMap((row) => (row.digit === null ? [] : [row.digit]));
  const low = digits[0];
  const high = digits[digits.length - 1];
  const keys =
    low === undefined || high === undefined
      ? ''
      : low === high
        ? `${String(low)} pick · `
        : `${String(low)}-${String(high)} pick · `;
  return `${keys}arrows move · Enter answer · Esc leave`;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** One answer as it was actually laid out. `index` is into `view.options`. */
export type DialogueRow = {
  readonly index: number;
  readonly option: DialogueOptionView;
  /** The whole row, reason line included. What a click is tested against. */
  readonly rect: PanelRect;
  /** The column the LABEL is drawn in, and therefore measured against. */
  readonly label: PanelRect;
  /** The column the reason is drawn in. Zero-height on an enabled row. */
  readonly reason: PanelRect;
  /** The digit drawn on it, or null past the ninth. */
  readonly digit: number | null;
};

export type DialogueGeometry = {
  /** 64x64, top-left of the body. `engine/dialogs/Chat.lua:58`. */
  readonly portrait: PanelRect;
  /** The column the spoken line is wrapped into. */
  readonly text: PanelRect;
  /** `engine/dialogs/Chat.lua:55`'s rule between the line and the list. */
  readonly separatorY: number;
  /** The rows that FIT. Never longer than the band allows. */
  readonly rows: readonly DialogueRow[];
  /** Index of the first option placed, so the caller can page without guessing. */
  readonly first: number;
  /** How many options did not fit, above and below. Zero means the list is whole. */
  readonly hidden: number;
  /** Where "5-8 of 8" goes, or null when nothing is hidden. */
  readonly count: PanelRect | null;
};

/**
 * WHERE THE WINDOW GOES. Never null, and clamped into `panelBand`.
 *
 * ═══ A BAND, NOT THE VIEWPORT, AND THAT ONE LINE IS THE CO-OP DECISION ═══
 * ui/classpicker.ts takes the whole window because nothing behind it is
 * pressable. Behind THIS one is a live town with five friends walking around in
 * it, and the player who is talking should be able to watch them. Clamped into
 * the band it can never come to rest over the hotbar, the resource strip or the
 * prose lines. There is no scrim for the same reason, and a stronger one: a
 * scrim would imply the world had stopped, which is the single thing this
 * feature must never imply.
 *
 * ═══ NEVER NULL, WHICH THE OTHER DOCK PANELS ARE ═══
 * The sheet, the talent panel and the inventory all answer null on a band too
 * short for them, and pressing their key then appears to do nothing — honest,
 * because nothing was holding the player. Here the SERVER has parked the body
 * until the conversation ends, so a window that declined to draw would be a
 * player who cannot act and has nothing on screen saying why. It shrinks and
 * pages instead; `dialogueGeometry` places what fits and says how much it did
 * not.
 *
 * DOCKED TO THE FOOT OF THE BAND, because that is where a conversation sits in
 * every game that has one, and because the band above it is the part the talker
 * is still watching. At the floor viewport the window is 516 of 640 pixels and
 * covers the middle of the map with it — including, the camera being
 * player-centred, the talker's own token. That is measured and it is the cost of
 * a window big enough to read; the claim that is NOT made any more is that they
 * can watch their own body.
 *
 * ═══ AND IT IS PUSHED TO THE RIGHT-HAND END OF THE BAND, NOT CENTRED ═══
 * A centred window sat straight on top of the Case Log, which is the surface the
 * host ruling designates for following the conversation ("a STORY exchange goes
 * to the WHOLE party's Case Log" — server/net/gateway.ts#recordDialogue). The
 * log's home is the bottom LEFT (ui/caselog.ts, `Minimalist.lua:381`) and it is
 * about half the viewport wide, so centred it lost the right 41% of every line
 * at 1262x428 and its RECORD/MARGIN chips at 640x320 — the chips a non-lead
 * needs in order to switch to the lane they are being told to read. Right-docked
 * it clears the log entirely at the Activity size and uncovers the chips at the
 * floor. It is the same handshake the party pane used to make with the log, made
 * one-sided because this window is not draggable.
 *
 * WHEN THE WINDOW IS AS WIDE AS THE BAND ALLOWS the two are the same rect, and
 * that is not a special case to write down: `width - w - MARGIN` is `MARGIN`.
 */
export function dialogueRect(
  view: DialogueView,
  width: number,
  band: { readonly top: number; readonly bottom: number },
): PanelRect {
  const w = Math.max(0, Math.min(DIALOGUE_MAX_W, width - DIALOGUE_MARGIN * 2));
  const bandH = Math.max(0, band.bottom - band.top);
  // THE ROWS ARE SUMMED, NOT COUNTED. A greyed row is taller than a live one by
  // its reason line, and `options.length * OPTION_ROW_H` under-reserved by
  // exactly that on every frame a non-lead sees — measured, it clipped a
  // four-answer node down to two on a 428-tall viewport with the band half
  // empty. The host rule's own row was the one that fell off.
  const rowsH = view.options.reduce((sum, option) => sum + rowHeight(option), 0);
  const wantH = HEADER_H + INSET * 2 + bodyHeight() + SEPARATOR_H + rowsH;
  const h = Math.min(wantH, bandH);
  return { x: Math.max(0, width - w - DIALOGUE_MARGIN), y: band.bottom - h, w, h };
}

/** The line and the face sit side by side, so the taller of the two rules. */
function bodyHeight(): number {
  return Math.max(PORTRAIT_PX, LINE_ROWS * LINE_H);
}

/** A disabled row is taller by its reason line. See `REASON_ROW_H`. */
function rowHeight(option: DialogueOptionView): number {
  return OPTION_ROW_H + (option.enabled ? 0 : REASON_ROW_H);
}

/**
 * Place rows from `first` downward, stopping before one that would not fit whole.
 *
 * NEVER HALF A ROW — ui/escapemenu.ts's `place()` states the rule and this is
 * the same one: half an answer is an answer somebody reads wrong and presses.
 */
function placeRows(
  view: DialogueView,
  x: number,
  innerW: number,
  top: number,
  bottom: number,
  first: number,
): readonly DialogueRow[] {
  const rows: DialogueRow[] = [];
  let y = top;
  for (let i = first; i < view.options.length; i += 1) {
    const option = view.options[i];
    if (option === undefined) break;
    const h = rowHeight(option);
    if (y + h > bottom) break;
    const labelX = x + MARK_W + PREFIX_W;
    rows.push({
      index: i,
      option,
      rect: { x, y, w: innerW, h },
      label: { x: labelX, y, w: Math.max(0, x + innerW - labelX), h: OPTION_ROW_H },
      reason: {
        x: labelX,
        y: y + OPTION_ROW_H,
        w: Math.max(0, x + innerW - labelX),
        h: option.enabled ? 0 : REASON_ROW_H,
      },
      digit: i < MAX_DIGIT ? i + 1 : null,
    });
    y += h;
  }
  return rows;
}

/**
 * EVERYTHING INSIDE THE WINDOW, IN ONE PASS.
 *
 * `selected` is an index into `view.options` (or -1). It is taken here — rather
 * than only by the painter — because the list PAGES: the window of rows that
 * fits has to be the window the selection is in, or the arrows would walk the
 * selection off a screen that never scrolled after it.
 *
 * ═══ THE PAGE IS THE EARLIEST ONE THAT HOLDS THE SELECTION, AND THAT IS ALSO
 *     THE MOST OF THE GREYED ROWS IT CAN SHOW ═══
 * `first` walks UP from zero and stops at the first page containing `selected`,
 * so any row above the selection that could share a page with it is on that
 * page. A greyed story row is therefore dropped only when NO page holds it
 * together with an answer this player may actually give — it is taller than a
 * live row by its reason line, and the arrows cannot rest on it, so on a band
 * with room for two rows a 25px greyed row and a 14px live one may not fit at
 * all. Measured: 640x320 in combat, the four-answer rumour node, the greyed row
 * at index 1 never appears at any selection.
 *
 * WHAT THE PLAYER IS LEFT WITH IS THE COUNT LINE — "1-1 of 4" is a sentence
 * saying the list is longer than the window — and nothing is lost that they
 * could have acted on, since the row they cannot see is the one row they could
 * never have given. It is a real limit and it is written down rather than
 * papered over: the fix, when a node needs it, is capacity (the 64px face is the
 * whole of the difference) and not a second scroll offset.
 *
 * ═══ THE COUNT LINE IS RESERVED IN A SECOND PASS, NOT GUESSED AT ═══
 * Reserving twelve pixels for "5-8 of 8" unconditionally would cost a whole
 * answer row on every short band that did not need one. So the rows are placed
 * against the full height first, and only if something was left over are they
 * placed again against a height with the line subtracted. Two passes over at
 * most a handful of rows, and no third state to get wrong.
 */
export function dialogueGeometry(
  view: DialogueView,
  rect: PanelRect,
  selected = -1,
): DialogueGeometry {
  const x = rect.x + INSET;
  const innerW = Math.max(0, rect.w - INSET * 2);
  const top = rect.y + HEADER_H + INSET;
  const bottom = rect.y + rect.h - INSET;

  const portrait: PanelRect = { x, y: top, w: PORTRAIT_PX, h: PORTRAIT_PX };
  const textX = x + PORTRAIT_PX + PORTRAIT_GAP;
  const text: PanelRect = {
    x: textX,
    y: top,
    w: Math.max(0, x + innerW - textX),
    h: LINE_ROWS * LINE_H,
  };
  const separatorY = top + bodyHeight() + Math.floor(SEPARATOR_H / 2);
  const rowsTop = top + bodyHeight() + SEPARATOR_H;

  const total = view.options.length;
  // THE PAGE IS DERIVED FROM THE SELECTION, never held as a second piece of
  // state: a stored scroll offset and a stored selection are two facts that
  // disagree the moment the frame is replaced, and the server replaces this
  // frame on every answer (`engine/dialogs/Chat.lua:113-118`'s `regen`).
  let first = 0;
  let rows = placeRows(view, x, innerW, rowsTop, bottom, first);
  let floor = bottom;
  if (rows.length < total) {
    floor = bottom - COUNT_H;
    rows = placeRows(view, x, innerW, rowsTop, floor, first);
  }
  while (
    selected >= 0 &&
    selected < total &&
    rows.length > 0 &&
    !rows.some((row) => row.index === selected)
  ) {
    first += 1;
    if (first > selected) break;
    rows = placeRows(view, x, innerW, rowsTop, floor, first);
  }

  const shown = rows.length;
  const hidden = total - shown;
  return {
    portrait,
    text,
    separatorY,
    rows,
    first,
    hidden,
    count: hidden > 0 ? { x, y: floor, w: innerW, h: COUNT_H } : null,
  };
}

/**
 * What a LOGICAL backbuffer point is over, or null.
 *
 * NULL MEANS "ON THE WINDOW, BUT NOT ON A ROW" for a point inside `rect`, and
 * the caller must still swallow that press — ui/classpicker.ts states the rule
 * and the cost here is concrete: a click that fell through would go out as a
 * travel order, and a travel order is a turn verb, and a turn verb closes the
 * conversation server-side. A misclick on the panel's own padding would end the
 * conversation it landed on.
 */
export function dialogueHitAt(
  view: DialogueView,
  rect: PanelRect,
  selected: number,
  px: number,
  py: number,
): DialogueRow | null {
  const geometry = dialogueGeometry(view, rect, selected);
  for (const row of geometry.rows) {
    if (px >= row.rect.x && px < row.rect.x + row.rect.w) {
      if (py >= row.rect.y && py < row.rect.y + row.rect.h) return row;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Selection and answering
// ---------------------------------------------------------------------------

/**
 * The first row this player may actually give, or -1.
 *
 * A GREYED ROW IS NEVER SELECTED, and that is ruling 3 read the strict way: the
 * story row is SHOWN to a non-lead so they know the answer exists and who can
 * give it, and it is not SELECTABLE, so neither the arrows nor a digit can park
 * on something that cannot happen. The reason is drawn on the row itself, so
 * nothing is hidden by refusing to focus it.
 */
export function dialogueFirstEnabled(view: DialogueView): number {
  return view.options.findIndex((option) => option.enabled);
}

/**
 * Step the selection, skipping what this player may not give, and WRAPPING.
 *
 * `engine/ui/VariableList.lua:108-115` moves its selection with
 * `util.boundWrap`, so upstream's answer list wraps from the last row to the
 * first. It is kept here, unlike ui/classpicker.ts's roster — which clamps
 * deliberately, because one key too many there plays the wrong character
 * forever, and one key too many here moves a highlight.
 *
 * Returns -1 when there is nothing to select, which cannot happen on a frame the
 * server built (every node carries an unconditional `leave`) and is still not
 * allowed to loop forever if it ever does.
 */
export function dialogueStep(view: DialogueView, selected: number, delta: number): number {
  const total = view.options.length;
  if (total === 0 || delta === 0) return selected;
  let at = selected;
  for (let n = 0; n < total; n += 1) {
    at = at < 0 ? (delta > 0 ? 0 : total - 1) : (at + delta + total) % total;
    if (view.options[at]?.enabled === true) return at;
  }
  return dialogueFirstEnabled(view);
}

export const DialogueAnswerKind = {
  /** Send it. `optionId` is the authored id, never a row number. */
  Say: 'say',
  /** A greyed row was pressed. Say why, out loud — see below. */
  Refused: 'refused',
} as const;
export type DialogueAnswerKind = (typeof DialogueAnswerKind)[keyof typeof DialogueAnswerKind];

export type DialogueAnswer =
  | { readonly kind: typeof DialogueAnswerKind.Say; readonly optionId: string }
  | { readonly kind: typeof DialogueAnswerKind.Refused; readonly reason: string };

/**
 * What pressing row `index` means. Null when there is no such row.
 *
 * ═══ A GREYED ROW ANSWERS `Refused` RATHER THAN NOTHING ═══
 * The silent no-op is what client/main.ts's header calls the worst failure mode
 * there is, and it would be exactly what a non-lead got for pressing the row
 * that is the whole reason this feature has a host rule. So the press is
 * consumed and the reason — which NAMES THE LEAD — is handed back for the
 * caller to show. Nothing goes to the server: a story answer from a non-lead is
 * refused there too, and a client that sent one anyway would be asking to be
 * told off in a language the player cannot read.
 */
export function dialogueAnswerAt(view: DialogueView, index: number): DialogueAnswer | null {
  const option = view.options[index];
  return option === undefined ? null : answerFor(option);
}

/**
 * ONE ANSWER RULE, READ BY BOTH DOORS. `dialogueAnswerAt` is the click and the
 * Enter key; `dialogueAnswerForDigit` is the number keys. They differ in how
 * they FIND the row and must not differ in what pressing it means — a second
 * copy of `enabled ? say : refuse` is how one of the four doors ends up reading
 * a scope instead.
 */
function answerFor(option: DialogueOptionView): DialogueAnswer {
  if (option.enabled) return { kind: DialogueAnswerKind.Say, optionId: option.id };
  return {
    kind: DialogueAnswerKind.Refused,
    reason: option.reason ?? 'that is not yours to answer',
  };
}

/**
 * What pressing digit `n` (1-based, as drawn) means.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * BOUNDED BY THE ROWS THAT WERE PLACED, WHICH IS NOT THE SAME AS THE LIST
 * ═══════════════════════════════════════════════════════════════════════════
 * This took the view and indexed `view.options`, and the docblock claimed it was
 * `client/main.ts` bounding the class chooser's digits by `pickerCards().length`
 * — but `pickerCards()` is the cards that were LAID OUT and `view.options` is
 * not. Measured on the 640x320 floor in combat with a twenty-answer node: two
 * rows drawn, and digit 9 answered `Say` for an option nobody had read. For a
 * lead every row is enabled, so that is a STORY answer sent off a key press
 * against a row that was never on the screen.
 *
 * So a digit is resolved through `DialogueGeometry.rows` — the same placement
 * the painter draws the `[n]` from and `dialogueHint` prints the range of. A key
 * with no bracket on the screen finds nothing and does nothing, which is what
 * the old docblock said and what this now is.
 *
 * `MAX_DIGIT` is still checked first, so a tenth digit is refused even on a page
 * that placed one.
 */
export function dialogueAnswerForDigit(
  geometry: DialogueGeometry,
  digit: number,
): DialogueAnswer | null {
  if (digit < 1 || digit > MAX_DIGIT) return null;
  const row = geometry.rows.find((placed) => placed.digit === digit);
  if (row === undefined) return null;
  return answerFor(row.option);
}

// ---------------------------------------------------------------------------
// The face
// ---------------------------------------------------------------------------

/**
 * The seventeenth face: somebody with no portrait of their own and no body to
 * borrow one from.
 *
 * IT IS A REAL ASSET AND IT IS THE LAST PICTURE BEFORE LETTERS. `DialogueView.portrait`
 * is OPTIONAL on the wire and `sprite` can miss as easily as anything else, so
 * the chain needs a picture for "a person we have nothing for" that is not a
 * pair of initials. That is exactly what this PNG was drawn for, and naming it
 * here is what makes it loadable — an id nothing asks for is filtered out of
 * the manifest before it can load, whatever prefix admits it.
 */
export const PORTRAIT_UNKNOWN = 'chr_portrait_unknown';

export const PortraitSource = {
  /** `chr_portrait_<person>`, 64x64, blitted 1:1. */
  Portrait: 'portrait',
  /** The 48x64 map body, feet on the floor of the box. */
  Sprite: 'sprite',
  /** `chr_portrait_unknown` — a face for somebody we have nothing else for. */
  Unknown: 'unknown',
  /** Two letters on a plate. Never a violet missing-asset box. */
  Initials: 'initials',
} as const;
export type PortraitSource = (typeof PortraitSource)[keyof typeof PortraitSource];

/**
 * WHICH FACE THIS SPEAKER GETS, decided once.
 *
 * ═══ PORTRAIT, THEN BODY, THEN LETTERS — AND THE MIDDLE ONE IS THE POINT ═══
 * `client/public/assets/` is gitignored wholesale, so a bare clone has no art at
 * all and every id here misses. The 48x64 standing body is the same PNG the map
 * draws, fits a 64x64 box whole at d=1, and reads as a character card with its
 * feet on the floor — so the feature is presentable with zero portrait files and
 * improves one PNG at a time as they land.
 *
 * ═══ AND THE GENERIC FACE SITS BETWEEN THE BODY AND THE LETTERS ═══
 * THAT IS AN ADDITION TO THE THREE, NOT A REORDERING OF THEM. A player's OWN
 * body is a better picture of them than a stranger's face, so
 * `chr_portrait_unknown` must not outrank `sprite` — but it is a far better
 * picture than two letters, and it is the seventeenth PNG that was installed
 * alongside the sixteen named ones for exactly this gap. Letters stay last,
 * because they are the answer for a clone with no art at all.
 *
 * NEVER THE RENDERER'S VIOLET MISSING-ASSET BOX. `client/main.ts`'s
 * `NEEDED_ASSET_PREFIXES` note is the rule and `panel.ts#blitReduced` is the
 * mechanism: it returns `false` rather than throwing, and returning false is
 * what hands the caller back its own fallback.
 *
 * EXACT SIZE ONLY, NO SCALING. `blitReduced` searches whole divisors and this
 * asks it for d=1, so a portrait that is not 64x64 is refused rather than
 * squashed — a face at a fractional scale is torn, and a face cropped to fit is
 * a nose (panel.ts records all three surfaces that learned that).
 */
export function dialoguePortraitSource(view: DialogueView, sprites: SpriteSource): PortraitSource {
  const portrait = view.portrait === undefined ? undefined : sprites.sprite(view.portrait);
  if (portrait !== undefined && portrait.w <= PORTRAIT_PX && portrait.h <= PORTRAIT_PX) {
    return PortraitSource.Portrait;
  }
  const body = sprites.sprite(view.sprite);
  if (body !== undefined && body.w <= PORTRAIT_PX && body.h <= PORTRAIT_PX) {
    return PortraitSource.Sprite;
  }
  const generic = sprites.sprite(PORTRAIT_UNKNOWN);
  if (generic !== undefined && generic.w <= PORTRAIT_PX && generic.h <= PORTRAIT_PX) {
    return PortraitSource.Unknown;
  }
  return PortraitSource.Initials;
}

/** Up to two letters of a name. `Merrow Stitch` -> `MS`. ui/classpicker.ts's. */
export function dialogueInitials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
  return letters === '' ? '?' : letters.slice(0, 2);
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

/**
 * The spoken line, wrapped into the column it is DRAWN in.
 *
 * Exported because a test that measured it against `rect.w` would be testing its
 * own copy of the arithmetic and would pass while the line hung over the
 * portrait — ui/caselog.ts:764-786 is that bug, shipped.
 */
export function dialogueLines(
  ctx: CanvasRenderingContext2D,
  view: DialogueView,
  geometry: DialogueGeometry,
): readonly string[] {
  ctx.font = FONT_BODY;
  return wrapClamped(ctx, view.text, geometry.text.w, LINE_ROWS);
}

export type DialogueDrawOptions = {
  readonly ctx: CanvasRenderingContext2D;
  readonly sprites: SpriteSource;
  readonly rect: PanelRect;
  readonly view: DialogueView;
  /** Index into `view.options`, or -1. */
  readonly selected: number;
  /** The row under the pointer, or -1. */
  readonly hovered?: number;
};

/** A traced box and letters, the plate a missing picture leaves behind. */
function drawLetterPlate(ctx: CanvasRenderingContext2D, box: PanelRect, letters: string): void {
  if (box.w <= 0 || box.h <= 0) return;
  ctx.fillStyle = PALETTE.VOID;
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.fillStyle = PALETTE.SLATE;
  ctx.fillRect(box.x, box.y, box.w, 1);
  ctx.fillRect(box.x, box.y + box.h - 1, box.w, 1);
  ctx.fillRect(box.x, box.y, 1, box.h);
  ctx.fillRect(box.x + box.w - 1, box.y, 1, box.h);
  ctx.font = FONT_FALLBACK;
  ctx.textAlign = 'center';
  ctx.fillStyle = PALETTE.SILVER;
  ctx.fillText(letters, box.x + box.w / 2, box.y + box.h / 2);
  ctx.textAlign = 'left';
}

/**
 * THE WINDOW.
 *
 * ═══ SELECTION IS A SHAPE AND A COLOUR, AND THE SHAPE IS THE ONE THAT COUNTS ═══
 * ui/classpicker.ts:52-59's rule: a `▸` in front of the row (shape) and the
 * label in GOLD (colour), so a player who cannot separate gold from bone still
 * has a mark to read. This claimed a third signal — "the digit's brackets
 * filled" — and there is no such thing: the bracket is the same `[n]` glyph in
 * whatever ink the row has, which is colour again, and past the ninth row there
 * is no bracket at all. Two signals, said honestly.
 *
 * ═══ AND HOVER IS A SHAPE TOO, WHICH IT WAS NOT ═══
 * ui/escapemenu.ts:2124-2126 is explicit — *"THE HOVER MARKER IS A SHAPE. A row
 * that is only brighter is a row a player with the contrast turned down cannot
 * find."* This drew BONE -> PARCHMENT and nothing else, which at 1:1 is barely
 * perceptible. The hovered row now also wears a bar down its marker column: the
 * column is empty on any row that is not selected, so the bar and the `▸` can
 * never collide, and the two marks are different shapes rather than two
 * brightnesses of the same one.
 *
 * ═══ NO CRIMSON ANYWHERE ═══
 * render/canvas.ts reserves it for one fact — hostiles are engaged — and a
 * greyed answer row is not an alarm.
 *
 * ═══ AND A GREYED ROW IS DIM, NOT ILLEGIBLE ═══
 * It was `GREY` on the CaseFile skin, which MEASURES 1.63:1 on the label and
 * 1.36:1 on the italic reason — the sentence naming the lead, which is the whole
 * payload of the host ruling, was the least readable text on the screen.
 * `GREY_HI` is 4.93:1 against the same skin and still plainly dimmer than the
 * BONE of a live row, so "not through you" survives and "who can" is readable.
 * ui/escapemenu.ts:2119-2121 solves the same problem the other way, with an INK
 * plate under every row; this surface has no plate and one ink to raise.
 *
 * ═══ THE CONTEXT IS LEFT AS IT WAS FOUND ═══
 * `save`/`restore` around the whole body. ui/turncards.ts:786-790 records what a
 * leaked `ctx.filter` does and panel.ts's `drawScrim` the same for
 * `globalAlpha`: it presents as the whole screen being wrong and gets diagnosed
 * as a broken PNG.
 */
export function drawDialogue(options: DialogueDrawOptions): void {
  const { ctx, sprites, rect, view, selected } = options;
  const hovered = options.hovered ?? -1;
  if (rect.w <= 0 || rect.h <= 0) return;

  ctx.save();
  drawPanel(ctx, sprites, PanelSkin.CaseFile, rect);

  // THE LAYOUT FIRST, because the hint printed on the header names the DIGITS
  // THAT WERE PLACED and the placement is what knows them. See `dialogueHint`.
  const geometry = dialogueGeometry(view, rect, selected);

  // ═══ THE HEADER IS THE SPEAKER'S NAME — `engine/dialogs/Chat.lua:40` titles
  //     the dialog with `self.npc.name` and nothing else ═══
  // The hint rides the right end of the same strip, and the name is fitted
  // against what the hint leaves rather than against the whole strip: a long
  // name measured against the full width would be drawn straight under the keys.
  ctx.font = FONT_SHORTCUT;
  const hint = dialogueHint(geometry.rows);
  const hintW = ctx.measureText(hint).width;
  ctx.font = FONT_NAME;
  const titleW = Math.max(0, rect.w - PANEL_PAD * 2 - hintW - PORTRAIT_GAP);
  drawHeader(ctx, sprites, fitText(ctx, view.speakerName, titleW), rect, FONT_NAME);
  ctx.font = FONT_SHORTCUT;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = PALETTE.GREY_HI;
  ctx.fillText(hint, rect.x + rect.w - PANEL_PAD, rect.y + HEADER_H / 2);
  ctx.textAlign = 'left';

  // ═══ THE FACE ═══
  const source = dialoguePortraitSource(view, sprites);
  if (source === PortraitSource.Portrait && view.portrait !== undefined) {
    // 1:1 AND NEVER SCALED — `maxReduction` of one, so a portrait that is not
    // the authored size is refused here and caught by the branch below rather
    // than drawn at a size nobody chose.
    blitReduced(ctx, sprites, view.portrait, geometry.portrait, BlitAnchor.Centre, 1);
  } else if (source === PortraitSource.Sprite) {
    blitReduced(ctx, sprites, view.sprite, geometry.portrait, BlitAnchor.Bottom, 1);
  } else if (source === PortraitSource.Unknown) {
    blitReduced(ctx, sprites, PORTRAIT_UNKNOWN, geometry.portrait, BlitAnchor.Centre, 1);
  } else {
    drawLetterPlate(ctx, geometry.portrait, dialogueInitials(view.speakerName));
  }

  // ═══ WHAT THEY SAID ═══
  const lines = dialogueLines(ctx, view, geometry);
  ctx.font = FONT_BODY;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = PALETTE.PARCHMENT;
  for (let i = 0; i < lines.length; i += 1) {
    ctx.fillText(lines[i] ?? '', geometry.text.x, geometry.text.y + i * LINE_H);
  }

  // ═══ THE RULE BETWEEN THE LINE AND THE LIST — `engine/dialogs/Chat.lua:55` ═══
  // GREY, NOT SLATE. Sampled on the CaseFile skin, SLATE is 1.09:1 against it —
  // a rule that is not there is a port of a separator in name only, and the
  // whole reason `:55` is cited is that the line and the answers are two things.
  ctx.fillStyle = PALETTE.GREY;
  ctx.fillRect(rect.x + INSET, geometry.separatorY, Math.max(0, rect.w - INSET * 2), 1);

  // ═══ THE ANSWERS ═══
  for (const row of geometry.rows) {
    const live = row.option.enabled;
    const chosen = live && row.index === selected;
    const over = live && row.index === hovered;
    const ink = !live
      ? PALETTE.GREY_HI
      : chosen
        ? PALETTE.GOLD
        : over
          ? PALETTE.PARCHMENT
          : PALETTE.BONE;

    ctx.textBaseline = 'middle';
    const midY = row.rect.y + OPTION_ROW_H / 2;

    if (chosen) {
      ctx.font = FONT_SHORTCUT;
      ctx.fillStyle = PALETTE.GOLD;
      ctx.fillText('▸', row.rect.x, midY);
    } else if (over) {
      // THE HOVER MARK, AND IT IS A SHAPE — see the header. The marker column is
      // empty on every row that is not the selected one, so this bar cannot land
      // on top of the `▸`, and it is two pixels rather than a glyph so it reads
      // as an edge rather than as a second kind of cursor.
      ctx.fillStyle = PALETTE.PARCHMENT;
      ctx.fillRect(row.rect.x, row.rect.y + 2, 2, OPTION_ROW_H - 4);
    }

    if (row.digit !== null) {
      ctx.font = FONT_SHORTCUT;
      ctx.fillStyle = ink;
      ctx.fillText(`[${String(row.digit)}]`, row.rect.x + MARK_W, midY);
    }

    // MEASURED AGAINST `row.label`, THE COLUMN IT IS DRAWN IN — the marker and
    // the bracket are already subtracted from it. See this file's header.
    ctx.font = FONT_BODY;
    ctx.fillStyle = ink;
    ctx.fillText(fitText(ctx, row.option.label, row.label.w), row.label.x, midY);

    if (!live) {
      // ═══ AND THE REASON, NAMING THE PERSON WHO CAN ═══ "Only Dalt can answer
      // for the party" is an instruction to turn to somebody; "unavailable" is a
      // bug report. The server writes the sentence; this draws it.
      ctx.font = FONT_REASON;
      // THE SAME INK AS THE LABEL ABOVE IT, and italic is what separates them.
      // The italic face has thinner stems, so it measured DIMMER than the label
      // at the same colour — 1.36:1 — and this is the sentence that tells a
      // non-lead who to turn to.
      ctx.fillStyle = PALETTE.GREY_HI;
      ctx.fillText(
        fitText(ctx, row.option.reason ?? '', row.reason.w),
        row.reason.x,
        row.reason.y + REASON_ROW_H / 2,
      );
    }
  }

  // ═══ AND HOW MANY DID NOT FIT — WORDS AND A COUNT, NEVER A BAR ═══
  // ui/escapemenu.ts's `escapeMenuPaging` is the precedent: a scrollbar on a
  // surface this small is three pixels of decoration, and "5-8 of 8" is a
  // sentence a player can act on.
  if (geometry.count !== null) {
    const shown = geometry.rows;
    const firstShown = (shown[0]?.index ?? geometry.first) + 1;
    const lastShown = (shown[shown.length - 1]?.index ?? geometry.first) + 1;
    ctx.font = FONT_SHORTCUT;
    ctx.fillStyle = PALETTE.GREY_HI;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      shown.length === 0
        ? `${String(view.options.length)} answers, no room`
        : `${String(firstShown)}-${String(lastShown)} of ${String(view.options.length)}`,
      geometry.count.x + geometry.count.w,
      geometry.count.y + COUNT_H / 2,
    );
  }

  ctx.restore();
}
