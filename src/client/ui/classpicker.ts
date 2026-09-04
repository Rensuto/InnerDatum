/**
 * THE CLASS CHOOSER: the first screen a new player ever sees, and the only
 * genuinely modal surface in this client.
 *
 * ===========================================================================
 * IT IS ToME'S BIRTHER, REDUCED TO WHAT THIS GAME ACTUALLY HAS
 * ===========================================================================
 * `dialogs/Birther.lua` builds its subclass list as a `TreeList` of
 * `display_prop="name"` rows carrying a 32px class icon (`setSubclassIcon`,
 * tome/dialogs/Birther.lua:46-56; the list at :131-140), and pushes the SELECTED item's
 * `desc` into a side pane (`updateDesc`, :516-520). The descriptors themselves
 * put prose before numbers — `data/birth/classes/warrior.lua:46-56` is two
 * sentences of identity, then "Their most important stats are…", then the stat
 * modifiers, then life per level.
 *
 * THAT ORDER IS THE PORT, and it is an argument rather than a habit: a player
 * who has never played this game is answering "who am I" before "what are my
 * numbers", and a card that opens with `maxHp 68` answers the second question to
 * somebody who has not asked the first. So each card is, top down:
 *
 *   the portrait -> the name -> the description -> Life -> the resource pool ->
 *   the four talents
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THERE ARE TWO DECISIONS ON THIS SCREEN, AND THERE USED TO BE ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 * This block read "there is exactly one decision on this screen" and listed
 * races among the things upstream has that we do not. Origins landed, and the
 * change is TOWARDS `Birther.lua` rather than away from it: upstream shows a
 * race list and a class list at once, and every number a character starts with
 * is the sum of the two answers. See `ORIGIN_ROW_H` for why the second list is
 * a strip of chips and not a second row of cards.
 *
 * STILL ABSENT rather than shown disabled: sex, difficulty, permadeath,
 * campaign and stat rolls. A NAME FIELD IS ABSENT PERMANENTLY AND BY RULING —
 * a character is its Discord identity here, never a typed name, so that one is
 * not a gap waiting to be filled.
 *
 * ===========================================================================
 * THE ORDER OF THE CARDS IS THE SERVER'S AND IS NEVER RE-SORTED
 * ===========================================================================
 * `ClassOptionsMsg.options` is authored order and protocol.ts asks for it to be
 * respected: "a card that moves between two frames is a card somebody misclicks,
 * and this one is irreversible". That is the same promise ui/partypanel.ts:69-77
 * makes about the kick row and ui/turncards.ts:24-38 makes about the strip, and
 * this is the one place where getting it wrong cannot be undone by clicking
 * again — the class is written to a file and the chooser never comes back.
 *
 * ===========================================================================
 * THE SELECTION IS MARKED BY SHAPE AND BY WORD, NEVER BY COLOUR ALONE
 * ===========================================================================
 * Roughly one man in twelve cannot separate the red from the green and the
 * Discord overlay is not colour-managed. ui/partypanel.ts:78-92 and
 * ui/turncards.ts:66-99 both state the rule; a chosen class is precisely the
 * case it exists for. So a selected card carries THREE signals: a 2px drawn
 * border (a shape), the word SELECTED (a word), and gold (a colour). Any one of
 * the three can be lost and the card still reads as chosen.
 *
 * ===========================================================================
 * NO NEW ART, AND NO KEY DERIVED FROM A CLASS NAME
 * ===========================================================================
 * `ClassOptionView` carries `sprite`, `portrait` and `talents[].icon`, all asset
 * KEYS that arrive on the wire. ToME derives its own by mangling the class name
 * (`t.name:lower():gsub("[^a-z0-9]", "_")`, tome/dialogs/Birther.lua:47-48) and survives a
 * miss because it ships `unknown_32_bg.png`. THIS PROJECT HAS NO SUCH FALLBACK
 * ASSET AND CANNOT ADD ONE — client/public/assets/ is gitignored wholesale and
 * an unresolved key renders as the LOUD violet missing-asset box, on a bare
 * clone, on the first screen a new player sees. So nothing here builds a key,
 * and every miss falls back to letters, exactly as ui/hotbar.ts:193-201 and
 * ui/partypanel.ts:502 do. Today the talent icons are `icon_active_*`, a prefix
 * main.ts does not index at all, so the fallback is not a rare path — it is the
 * only path, and it has to be legible.
 *
 * ===========================================================================
 * MODAL, AND THAT COSTS NOBODY ELSE ANYTHING
 * ===========================================================================
 * This is the one surface that swallows the keyboard and both mouse buttons, and
 * it is safe to do so for a reason that is provable rather than hopeful: a player
 * seeing it has just connected and is a party of ONE (engine/party.ts:26-44), so
 * the barrier's quorum, commit count and Bell are all scoped to them alone. The
 * worst case is a solo Bell at 120 seconds followed by Standing By on their own
 * body. Nobody waits on them because there is nobody to wait.
 *
 * Geometry and hit-testing are PURE and share one function — see
 * ui/contextmenu.ts:24-34 for why a hit test may not hold a context, and
 * ui/partypanel.ts:93-99 for what two copies of this arithmetic cost.
 */

import { ResourceKind } from '../../shared/protocol.ts';
import { PALETTE } from '../render/canvas.ts';
import {
  drawButton,
  drawHeader,
  drawPanel,
  drawScrim,
  fitText,
  HEADER_H,
  PANEL_PAD,
  PanelSkin,
  wrapText,
} from './panel.ts';
import type { ClassOptionView, LoadoutTalent, OriginOptionView } from '../../shared/protocol.ts';
import type { SpriteSource } from '../render/assets.ts';
import type { PanelRect } from './panel.ts';

// ---------------------------------------------------------------------------
// Geometry constants
// ---------------------------------------------------------------------------

/**
 * Advance of one glyph in the 10px monospace this file draws with. The same six
 * pixels ui/tooltip.ts:69-74 and ui/contextmenu.ts:161 use — an estimate that
 * decides BOX sizes and nothing else. Every string is clamped by `fitText`
 * against the real inner width at paint time.
 */
const CHAR_W = 6;

/** Chrome lost on each side. Mirrors `panelInner`'s inset, as ui/tooltip.ts does. */
const INSET = PANEL_PAD + 3;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A CEILING AND A MARGIN. THERE IS NO PREFERRED WIDTH ANY MORE, AND THAT IS
 * THE FIX.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This was `PICKER_W = 560` on every screen ever made. Three cards inside 560
 * is a card of about 176 pixels, and after the icon and its gap the name column
 * holds ten monospace characters -- `Iron Curtain` is twelve, so it read
 * `Iron Curta…` at the 640x320 floor and equally at 1280x720, because a fixed
 * modal cannot be helped by a bigger window.
 *
 * THIS IS THE FIRST SCREEN A NEW PLAYER SEES. They are being asked to choose a
 * class, permanently, off four talent names each, and one of the twelve was cut
 * mid-word with two thirds of a large monitor unused behind the box.
 *
 * ═══ A FRACTION WAS TRIED AND MISSED THE ONE VIEWPORT THAT WAS BROKEN ═══
 * 0.78 of 640 is 499, which is LESS than the 560 it already was -- so every
 * viewport grew except the narrow one still doing the clipping. A fraction is
 * the right shape for a PANEL, which opens over a live map other players are
 * moving on. It is the wrong shape for a MODAL: nothing under this one is
 * pressable while it is up, which is what `classPickerRect` means by "allowed
 * to cover the hotbar", so there is nothing to leave visible and no reason to
 * hold pixels back. It takes the window, up to the cap.
 *
 * `pickerMaxW` is what stops it becoming a wall of whitespace on a wide monitor:
 * past it, more window buys nothing. The small-viewport case is untouched -- the
 * modal still shrinks rather than refusing, for the reason `classPickerRect`
 * records.
 *
 * ═══ IT WAS A FLAT 880 AND THAT NUMBER WAS SIZED FOR THREE CARDS ═══
 * The paragraph above used to end *"because there are only three cards"*. A
 * fourth class shipped. 880 across four is a card of 210 pixels, and
 * `The Alchemist of Ashwick Row` is twenty-eight characters -- so the modal went
 * straight back to clipping a class name mid-word on a 1920-pixel monitor, which
 * is the exact failure this whole block was written to kill, re-created by the
 * one number that still counted the cards.
 *
 * SO THE CAP IS DERIVED FROM THE COUNT NOW. `CARD_MAX_W` is what a card is
 * allowed to be, the cap is whatever holds that many of them, and a fifth class
 * costs nothing but a wider modal on a wide screen.
 */
const CARD_MAX_W = 282;

/**
 * The widest this modal is worth being, for `count` cards.
 *
 * 282 IS WHAT THREE CARDS ENJOYED AT THE OLD CAP -- measured, not chosen: 880
 * minus two insets, minus two gaps, over three. It is known good, because it is
 * the width that made `Iron Curtain` fit when this block was written.
 */
function pickerMaxW(count: number): number {
  const n = Math.max(1, count);
  return n * CARD_MAX_W + (n - 1) * CARD_GAP + INSET * 2;
}
const PICKER_MAX_H = 520;
const PICKER_MARGIN = 8;

/** One line of prose under the header: what to press. */
const HINT_H = 14;
/** The confirm button's band at the foot of the panel. */
const CONFIRM_H = 18;
const CONFIRM_W = 26 * CHAR_W;
/** Air between the cards and the confirm band. */
const CONFIRM_GAP = 6;
/** Between two cards. */
const CARD_GAP = 8;
/** Padding inside a card. */
const CARD_PAD = 5;
/** The 2px ring a selected card wears. A SHAPE — see the header. */
const SELECT_BORDER = 2;

/** The portrait box. `icon_character_*` are 64x64; blitted 1:1, never scaled. */
const PORTRAIT_PX = 64;
/** A talent's icon box on a card. Centre-cropped, never scaled. */
const TALENT_ICON = 16;
const TALENT_ROW_H = 18;
const ROW_H = 12;

const FONT_NAME = 'bold 12px ui-monospace, Consolas, monospace';
const FONT_BODY = '10px ui-monospace, Consolas, monospace';
const FONT_META = 'bold 10px ui-monospace, Consolas, monospace';
const FONT_SHORTCUT = 'bold 10px ui-monospace, Consolas, monospace';
/** The letters a card falls back to when its art is not on disk. Non-violet. */
const FONT_FALLBACK = 'bold 18px ui-monospace, Consolas, monospace';
const FONT_ICON_FALLBACK = 'bold 10px ui-monospace, Consolas, monospace';

const PICKER_TITLE = 'WHO ARE YOU?';
/**
 * The instruction, naming BOTH ways through, the way the erased plate does.
 *
 * The digit shortcut is advertised on the card itself as `[1]` — the same
 * grammar ToME uses for `[L]evelup` and `Manage [I]nventory`
 * (CharacterSheet.lua:95-99) — and this line names the rest of the keyboard,
 * because a modal that swallows every key must say which ones it kept.
 */
/**
 * THE DIGITS ARE COUNTED, NOT WRITTEN OUT.
 *
 * This was the literal string `pick with 1-3 …` and a fourth class shipped
 * behind it — so the screen taught three shortcuts while the server offered
 * four, and `4` worked and was never mentioned. `main.ts` bounds the digit
 * handler by `pickerCards().length`, which is the number this now reads.
 *
 * The same drift this codebase keeps catching: a literal restating a fact that
 * lives somewhere else, silent the day the fact moves.
 */
function pickerHint(count: number, hasOrigins = false): string {
  const keys = count <= 1 ? '1' : `1-${String(count)}`;
  // THE AXIS IS NAMED ONLY WHEN THERE IS ONE. A hint that mentioned an origin
  // row an older server never sent would be instructions for a control that is
  // not on the screen.
  const arrows = hasOrigins ? 'left/right' : 'the arrows';
  const origin = hasOrigins ? ' · up/down picks where you are from' : '';
  return `pick with ${keys} or ${arrows}${origin} · Enter confirms · this choice is permanent`;
}
const CONFIRM_LABEL = 'CONFIRM';
/** The word half of the selection mark. See the header: never colour alone. */
const SELECTED_WORD = 'SELECTED';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ORIGIN STRIP. `Birther.lua`'s OTHER list, and this screen now has two.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The docblock at the top of this file used to end "There is exactly one
 * decision on this screen." That was true and is not any more, and the change is
 * TOWARDS upstream rather than away: `Birther.lua` shows a race list and a class
 * list at once, and every number a character starts with is the sum of the two.
 *
 * ═══ A STRIP OF CHIPS, NOT A SECOND ROW OF CARDS ═══
 * The class cards are the expensive half of this screen — a portrait, a
 * description, a pool and four talents each — and there is not room for two of
 * those. An origin is three numbers and a sentence, so it gets a chip with the
 * sentence and the numbers on ONE shared line beneath. That also keeps the class
 * cards the visual answer to "WHO ARE YOU?", which is the question in the header.
 */
const ORIGIN_ROW_H = 18;
const ORIGIN_NOTE_H = 12;
const ORIGIN_GAP = 4;
const ORIGIN_CHIP_GAP = 6;

// ---------------------------------------------------------------------------
// Hit results
// ---------------------------------------------------------------------------

export const ClassPickerHitKind = {
  Card: 'card',
  /** A chip in the origin strip. `index` is into `origins`, never into `options`. */
  Origin: 'origin',
  Confirm: 'confirm',
} as const;
export type ClassPickerHitKind = (typeof ClassPickerHitKind)[keyof typeof ClassPickerHitKind];

export type ClassPickerHit =
  | { readonly kind: typeof ClassPickerHitKind.Card; readonly index: number }
  | { readonly kind: typeof ClassPickerHitKind.Origin; readonly index: number }
  | { readonly kind: typeof ClassPickerHitKind.Confirm };

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * WHERE THE MODAL GOES. Never null.
 *
 * Unlike every dock panel in this client, this one has no "not now" answer. A
 * player who owes a choice cannot play until they make it, so a viewport too
 * small for the preferred size gets a smaller modal rather than no modal —
 * returning null here would be a player staring at a map they cannot move on
 * with nothing on screen explaining why.
 *
 * Computed from the FULL VIEWPORT rather than from the map band, because a modal
 * is allowed to cover the hotbar: nothing under it is pressable while it is up.
 */
export function classPickerRect(width: number, height: number, count = 3): PanelRect {
  /**
   * THE WINDOW, UP TO THE CAP — not a fraction of it.
   *
   * A FRACTION WAS TRIED AND WAS WRONG AT THE FLOOR. 0.78 of 640 is 499, which
   * is less than the 560 this modal already was, so the narrow viewport -- the
   * one still clipping `Iron Curtain` -- got no growth at all while wider ones
   * did. There are 624 usable pixels at 640 and the modal was taking 560 of
   * them for no reason.
   *
   * A FRACTION IS THE RIGHT SHAPE FOR A PANEL AND THE WRONG ONE FOR A MODAL.
   * The character sheet keeps one because it opens over a live map that other
   * players are still moving on, so covering all of it costs something. Nothing
   * under this one is pressable while it is up -- that is what `classPickerRect`
   * means by "allowed to cover the hotbar" -- so there is nothing to leave
   * visible and no reason to hold pixels back.
   */
  // `count` DEFAULTS TO THREE so the fixtures that predate it compile unchanged,
  // and every real caller passes the options they are about to draw — see
  // `pickerMaxW` for why a hard-coded count was the bug.
  const wantW = Math.min(pickerMaxW(count), width - PICKER_MARGIN * 2);
  const wantH = Math.min(PICKER_MAX_H, height - PICKER_MARGIN * 2);

  // The outer clamp is unchanged and still last: a modal wider than its viewport
  // would centre to a negative x, and this one has no "not now" to fall back on.
  const w = Math.max(0, Math.min(wantW, width - PICKER_MARGIN * 2));
  const h = Math.max(0, Math.min(wantH, height - PICKER_MARGIN * 2));
  return {
    x: Math.floor((width - w) / 2),
    y: Math.floor((height - h) / 2),
    w,
    h,
  };
}

type PickerGeometry = {
  readonly cards: readonly PanelRect[];
  readonly confirm: PanelRect;
  /** The prose line under the header. Carried so the painter never re-derives it. */
  readonly hint: PanelRect;
  /** One chip per origin, in the server's order. Empty when the server sent none. */
  readonly origins: readonly PanelRect[];
  /** The one shared line under the chips, where the selected origin's numbers go. */
  readonly originNote: PanelRect;
};

/**
 * EVERYTHING INSIDE THE MODAL, IN ONE PASS.
 *
 * ONE function, called by the painter AND by `classPickerHitAt` AND by
 * `classPickerCards`, for the reason ui/partypanel.ts:93-99 records: two copies
 * of this arithmetic is a card drawn in one place and clicked in another, and
 * here the misclick writes the wrong class to a file forever.
 *
 * THE CARDS ARE A FIXED ROW: one column per option, in the order they arrived,
 * never wrapped and never re-sorted. A row that wrapped to two lines on a narrow
 * viewport would move card 3 under card 1, which is exactly the "card that moved
 * between two frames" protocol.ts refuses.
 */
function pickerGeometry(
  options: readonly ClassOptionView[],
  rect: PanelRect,
  origins: readonly OriginOptionView[] = [],
): PickerGeometry {
  const x = rect.x + INSET;
  const innerW = Math.max(0, rect.w - INSET * 2);
  const top = rect.y + HEADER_H + INSET;
  const bottom = rect.y + rect.h - INSET;

  const confirmW = Math.min(CONFIRM_W, innerW);
  const confirm: PanelRect = {
    x: rect.x + Math.floor((rect.w - confirmW) / 2),
    y: bottom - CONFIRM_H,
    w: confirmW,
    h: CONFIRM_H,
  };

  const hint: PanelRect = { x, y: top, w: innerW, h: HINT_H };

  /**
   * THE STRIP TAKES ITS HEIGHT OFF THE TOP OF THE CARDS, and it takes NOTHING
   * when the server sent no origins. That is the additive-field contract holding
   * at the layout layer: an older server sends no `origins`, this block reserves
   * zero pixels, and the screen is laid out exactly as it was before origins
   * existed rather than with a band of empty panel where a strip would go.
   */
  const stripH = origins.length === 0 ? 0 : ORIGIN_ROW_H + ORIGIN_NOTE_H + ORIGIN_GAP;
  const stripTop = top + HINT_H;
  const originRects: PanelRect[] = [];
  if (origins.length > 0) {
    const chipW = Math.floor((innerW - ORIGIN_CHIP_GAP * (origins.length - 1)) / origins.length);
    for (let i = 0; i < origins.length; i += 1) {
      originRects.push({
        x: x + i * (chipW + ORIGIN_CHIP_GAP),
        y: stripTop,
        w: Math.max(0, chipW),
        h: ORIGIN_ROW_H,
      });
    }
  }
  const originNote: PanelRect = {
    x,
    y: stripTop + ORIGIN_ROW_H,
    w: innerW,
    h: ORIGIN_NOTE_H,
  };

  const cardsTop = stripTop + stripH;
  const cardsH = Math.max(0, confirm.y - CONFIRM_GAP - cardsTop);
  const count = options.length;
  if (count === 0 || cardsH <= 0) {
    return { cards: [], confirm, hint, origins: originRects, originNote };
  }

  const cardW = Math.floor((innerW - CARD_GAP * (count - 1)) / count);
  const cards: PanelRect[] = [];
  for (let i = 0; i < count; i += 1) {
    cards.push({ x: x + i * (cardW + CARD_GAP), y: cardsTop, w: Math.max(0, cardW), h: cardsH });
  }
  return { cards, confirm, hint, origins: originRects, originNote };
}

/**
 * THE ONE LINE UNDER THE CHIPS: what the selected origin actually does.
 *
 * ═══ IT CARRIES THE WORD `SELECTED`, AND THAT IS THE THIRD SIGNAL ═══
 * A chip is too small for the word the class cards print, and this file's own
 * rule is that a selection is marked "by shape and by word, never by colour
 * alone" — roughly one man in twelve cannot separate the gold from the grey. The
 * chip supplies the shape (a 2px border) and the colour (gold); this line
 * supplies the word.
 *
 * ═══ THE NUMBERS ARE THE ONES UPSTREAM'S CARD PRINTS ═══
 * `human.lua:90-94` lists stat modifiers, then "Life per level", then
 * "Experience penalty". Same three, same order, in one line instead of five —
 * and the zeroes stay unsaid, because a baseline reading "+0 Strength, +0
 * Dexterity…" is furniture rather than information.
 */
function originNoteText(origin: OriginOptionView): string {
  const mods = Object.entries(origin.statMods)
    .filter(([, value]) => typeof value === 'number' && value !== 0)
    .map(([key, value]) => `${Number(value) > 0 ? '+' : ''}${String(value)} ${key.toUpperCase()}`);

  return [
    `${origin.name.toUpperCase()} — ${SELECTED_WORD}`,
    mods.length === 0 ? 'no stat modifiers' : mods.join(' '),
    `${String(origin.lifeRating)} life/level`,
    origin.experiencePenaltyPct === 0
      ? 'no experience penalty'
      : `${String(origin.experiencePenaltyPct)}% experience penalty`,
  ].join('  ·  ');
}

/**
 * The card rects, in the SERVER'S ORDER. Index i is `options[i]`, always.
 *
 * Exported so main.ts can drive the keyboard selection off the same list the
 * mouse hits, and so a test can assert the order survives without painting
 * anything.
 */
export function classPickerCards(
  options: readonly ClassOptionView[],
  rect: PanelRect,
  origins: readonly OriginOptionView[] = [],
): readonly PanelRect[] {
  return pickerGeometry(options, rect, origins).cards;
}

/**
 * The origin chip rects, in the SERVER'S ORDER. Index i is `origins[i]`, always.
 *
 * Exported for the same reason `classPickerCards` is: main.ts and the tests must
 * read the strip off the ONE function that lays it out, never re-derive it. Two
 * copies of this arithmetic is a chip drawn in one place and clicked in another,
 * and this choice is written to a file and never offered again.
 */
export function classPickerOriginChips(
  options: readonly ClassOptionView[],
  rect: PanelRect,
  origins: readonly OriginOptionView[],
): readonly PanelRect[] {
  return pickerGeometry(options, rect, origins).origins;
}

/**
 * What a LOGICAL backbuffer point is over, or null.
 *
 * NULL MEANS "ON THE MODAL, BUT NOT ON A CONTROL" — never "fall through". The
 * caller swallows every click while the picker is up (both buttons, and
 * `preventDefault`, or a right-click inside the modal opens a verb menu on the
 * tile behind it).
 *
 * THE CONFIRM BUTTON ANSWERS EVEN WHEN NOTHING IS SELECTED, deliberately: it
 * takes no `selected` argument at all, so a disabled-looking button still
 * SWALLOWS its click rather than letting it land on whatever is underneath —
 * the rule ui/contextmenu.ts:282-287 states for a disabled row. What the click
 * MEANS when there is no selection is the caller's business, and the honest
 * answer is "nothing happens and the button stays grey".
 */
export function classPickerHitAt(
  options: readonly ClassOptionView[],
  rect: PanelRect,
  px: number,
  py: number,
  origins: readonly OriginOptionView[] = [],
): ClassPickerHit | null {
  const inside = (r: PanelRect): boolean =>
    px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;

  const geometry = pickerGeometry(options, rect, origins);
  if (inside(geometry.confirm)) return { kind: ClassPickerHitKind.Confirm };
  for (let i = 0; i < geometry.origins.length; i += 1) {
    const chip = geometry.origins[i];
    if (chip !== undefined && inside(chip)) return { kind: ClassPickerHitKind.Origin, index: i };
  }
  for (let i = 0; i < geometry.cards.length; i += 1) {
    const card = geometry.cards[i];
    if (card !== undefined && inside(card)) return { kind: ClassPickerHitKind.Card, index: i };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

/** The word for a pool. A switch, so a fourth `ResourceKind` is a compile error. */
function resourceLabel(kind: ResourceKind): string {
  switch (kind) {
    case ResourceKind.Resolve:
      return 'Resolve';
    case ResourceKind.Focus:
      return 'Focus';
    case ResourceKind.Reagents:
      return 'Reagents';
    case ResourceKind.Ink:
      return 'Ink';
  }
}

/** Up to two letters of a name. `The Watchman` -> `TW`. Never violet. */
function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
  return letters === '' ? '?' : letters.slice(0, 2);
}

/**
 * The face, blitted 1:1 and centre-cropped into its box.
 *
 * NEVER SCALED — nearest-neighbour downscaling is exactly the resampling
 * render/canvas.ts's backbuffer exists to prevent. The map token (`sprite`) is
 * drawn beside it at its own authored size, because a player is about to spend
 * an evening looking at that 24x32 silhouette and the portrait does not show it.
 */
function blitCropped(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  key: string,
  box: PanelRect,
): boolean {
  const sprite = sprites.sprite(key);
  if (sprite === undefined || box.w <= 0 || box.h <= 0) return false;
  const sw = Math.min(sprite.w, box.w);
  const sh = Math.min(sprite.h, box.h);
  ctx.drawImage(
    sprite.image,
    Math.floor((sprite.w - sw) / 2),
    Math.floor((sprite.h - sh) / 2),
    sw,
    sh,
    box.x + Math.floor((box.w - sw) / 2),
    box.y + Math.floor((box.h - sh) / 2),
    sw,
    sh,
  );
  return true;
}

/** The plate a missing picture leaves behind: a traced box and letters. */
function drawLetterPlate(
  ctx: CanvasRenderingContext2D,
  box: PanelRect,
  letters: string,
  font: string,
): void {
  if (box.w <= 0 || box.h <= 0) return;
  ctx.fillStyle = PALETTE.VOID;
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.fillStyle = PALETTE.SLATE;
  ctx.fillRect(box.x, box.y, box.w, 1);
  ctx.fillRect(box.x, box.y + box.h - 1, box.w, 1);
  ctx.fillRect(box.x, box.y, 1, box.h);
  ctx.fillRect(box.x + box.w - 1, box.y, 1, box.h);
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.fillStyle = PALETTE.SILVER;
  ctx.fillText(letters, box.x + box.w / 2, box.y + box.h / 2);
  ctx.textAlign = 'left';
}

/**
 * ONE CARD, in the Birther's order: face, name, prose, then the numbers.
 *
 * Everything below the portrait is laid out with a running cursor and stops at
 * the bottom of the card, so a short viewport loses the LAST talent rather than
 * painting over the confirm button. Nothing is positioned against another
 * string's character count — every line is clamped by `fitText` or `wrapText`
 * against the real inner width.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A TALENT ACTUALLY DOES, IN THE WIDTH A CARD HAS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The picker drew four talent NAMES per class and nothing else, while the frame
 * it was drawing from already carried `cost`, `range`, `minRange` and
 * `cooldownTurns` for every one of them. "Iron Curtain" and "Fog Step" are good
 * names and they are not information: a player choosing their character for an
 * evening could not tell a melee talent from a ranged one, and the FIRST
 * decision in the game was the one they had least to go on.
 *
 * ═══ THE DEAD ZONE IS THE REASON THIS IS SHORTHAND AND NOT PROSE ═══
 * game-design.md § 2 calls the Inspector's `min_range 3` *"the single most
 * important thing"* about the class — they are helpless in a doorway. A player
 * who learns that after choosing has been told the most important fact too
 * late, and it fits in five characters: `3-5`.
 *
 * A CARD IS ~175px WIDE, so this is the same label-left/value-right grammar the
 * Life and resource rows above already use, rather than a wrapped paragraph
 * there is no room for.
 */
export function talentShorthand(talent: LoadoutTalent): string {
  /**
   * THE NUMBERS ARE READ OFF THE REAL CLASSES, NOT GUESSED. Measured:
   *
   *     Crude Blow     range=1.5 min=0     Revolver Shot  range=5 min=3
   *     Iron Curtain   range=1.5 min=0     Sniper's Mark  range=7 min=3
   *     Fog Step       range=3   min=0     Mend Wounds    range=0 min=0
   *
   * MELEE IS 1.5, not 1 — it is the diagonal-inclusive adjacency the engine
   * uses — and a first version testing `range <= 1` printed "1.5 tiles" on every
   * Watchman talent. RANGE 0 IS SELF, and that same version called Mend Wounds,
   * which heals every ally within two tiles, "melee".
   */
  const reach =
    talent.range <= 0
      ? 'self'
      : talent.range < 2
        ? 'melee'
        : talent.minRange > 0
          ? `${String(talent.minRange)}-${String(talent.range)}`
          : `${String(talent.range)} tiles`;
  return `${String(talent.cost.ap)} AP · ${reach}`;
}

function drawCard(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  option: ClassOptionView,
  rect: PanelRect,
  index: number,
  selected: boolean,
  hovered: boolean,
): void {
  if (rect.w <= 0 || rect.h <= 0) return;

  // The plate. A wash for the selected one, so the card reads as chosen from
  // the far side of the screen before any word is legible.
  ctx.fillStyle = selected ? PALETTE.SLATE : PALETTE.INK;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

  // THE SHAPE HALF OF THE SELECTION MARK: a 2px ring, or a 1px one under the
  // pointer, or a hairline. Three different THICKNESSES, so the state survives
  // greyscale and the corner of an eye.
  const border = selected ? SELECT_BORDER : 1;
  ctx.fillStyle = selected ? PALETTE.GOLD : hovered ? PALETTE.PARCHMENT : PALETTE.GREY;
  ctx.fillRect(rect.x, rect.y, rect.w, border);
  ctx.fillRect(rect.x, rect.y + rect.h - border, rect.w, border);
  ctx.fillRect(rect.x, rect.y, border, rect.h);
  ctx.fillRect(rect.x + rect.w - border, rect.y, border, rect.h);

  const x = rect.x + CARD_PAD;
  const w = Math.max(0, rect.w - CARD_PAD * 2);
  const bottom = rect.y + rect.h - CARD_PAD;
  let y = rect.y + CARD_PAD + border;

  // --- the shortcut, top-left, before anything else can push it around -----
  // `[1]`, the grammar ToME uses for `[L]evelup` (CharacterSheet.lua:99). It is
  // CONVENTIONAL rather than ported — ToME's birther has no digit shortcut — and
  // it is advertised because a modal that swallows the keyboard owes the player
  // a list of what it kept.
  ctx.font = FONT_SHORTCUT;
  ctx.fillStyle = selected ? PALETTE.GOLD : PALETTE.GREY_HI;
  ctx.fillText(`[${index + 1}]`, x, y + ROW_H / 2);

  if (selected) {
    // THE WORD HALF. Right-aligned on the shortcut's line so it never collides
    // with the name below, and never drawn for an unselected card — a permanent
    // label reading "NOT SELECTED" would be noise on two cards out of three.
    ctx.font = FONT_META;
    ctx.textAlign = 'right';
    ctx.fillStyle = PALETTE.GOLD;
    ctx.fillText(
      fitText(ctx, SELECTED_WORD, w - 4 * CHAR_W),
      rect.x + rect.w - CARD_PAD,
      y + ROW_H / 2,
    );
    ctx.textAlign = 'left';
  }
  y += ROW_H + 2;

  // --- the portrait, with the map token beside it ---------------------------
  const portraitW = Math.min(PORTRAIT_PX, w);
  const portrait: PanelRect = {
    x: x + Math.floor((w - portraitW) / 2),
    y,
    w: portraitW,
    h: Math.min(PORTRAIT_PX, Math.max(0, bottom - y)),
  };
  if (!blitCropped(ctx, sprites, option.portrait, portrait)) {
    drawLetterPlate(ctx, portrait, initialsOf(option.name), FONT_FALLBACK);
  }
  // The token is a courtesy, not a requirement: when it is missing nothing is
  // drawn in its place, because the portrait beside it already says who this is.
  blitCropped(ctx, sprites, option.sprite, {
    x: portrait.x + portrait.w + 2,
    y: portrait.y + portrait.h - 32,
    w: 24,
    h: 32,
  });
  y = portrait.y + portrait.h + 4;

  // --- the name -------------------------------------------------------------
  ctx.font = FONT_NAME;
  ctx.fillStyle = selected ? PALETTE.GOLD : PALETTE.PARCHMENT;
  ctx.fillText(fitText(ctx, option.name, w), x, y + 6);
  y += 14;

  // --- the prose, before any number. See the header ------------------------
  ctx.font = FONT_BODY;
  ctx.fillStyle = PALETTE.BONE;
  const lines = wrapText(ctx, option.description, w);

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * HOW MANY LINES THE CARD CAN ACTUALLY SPARE — not a flat four.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ═══ THE FLAT FOUR TRUNCATED ALL FOUR CLASSES, AT EVERY WIDTH ═══
   * `DESC_MAX_LINES = 4` was a guess, and the blurbs are 130-140 characters
   * apiece. At the old cap a card was 210 wide — about thirty-three columns —
   * so every class ended in an ellipsis with its last clause unreachable, ON
   * THE ONE SCREEN WHERE THE DECISION IS PERMANENT AND THERE IS NO SCROLL, NO
   * TOOLTIP AND NO EXPAND. Upstream's equivalent pane is a scrollable
   * `TextzoneList` fed the whole descriptor (tome/dialogs/Birther.lua:113, :516-520), and
   * ToME's descriptors are far longer than ours.
   *
   * ═══ THE BUDGET IS WHAT IS LEFT AFTER EVERYTHING BELOW IS PAID FOR ═══
   * The prose never takes a row from the numbers or from a talent, because the
   * reserve below is subtracted first. So a card that has the room shows the
   * whole blurb, a card that has not still ends in an honest ellipsis, and
   * neither outcome is a number somebody guessed.
   *
   * ═══ THE NUMBERS ARE RESERVED. THE TALENTS ARE NOT, AND THAT IS ON PURPOSE ═══
   * Reserving the talent rows too was tried and it INVERTED A DECISION THIS FILE
   * had already made and tested: at the 640x320 floor the prose would have been
   * cut to two lines so that four talent rows could fit, when the existing policy
   * is the other way round — the prose gets the room and the talent list concedes
   * with `+2 more`, which the block below argues at length and two tests pin.
   *
   * That policy is right and this change does not touch it. The talents' own
   * concession is the shock absorber; the two `field` rows are not, because a
   * card with no Life on it is a card missing a number the player is comparing.
   */
  const reserveBelow = 3 + ROW_H * 2 + 3;
  // AT LEAST ONE LINE. A card with the room for prose at all says something; the
  // loop's own `y + ROW_H > bottom` guard is what stops it drawing off the end.
  const descBudget = Math.max(1, Math.floor((bottom - y - reserveBelow) / ROW_H));

  for (let i = 0; i < lines.length && i < descBudget; i += 1) {
    const line = lines[i];
    if (line === undefined || y + ROW_H > bottom) break;
    // The last line this card can show gets an ellipsis when there is more,
    // rather than stopping mid-sentence as though the text simply ended.
    const more = i === descBudget - 1 && lines.length > descBudget;
    ctx.fillText(fitText(ctx, more ? `${line}…` : line, w), x, y + ROW_H / 2);
    y += ROW_H;
  }
  y += 3;

  // --- and only now the numbers --------------------------------------------
  const field = (label: string, value: string): void => {
    if (y + ROW_H > bottom) return;
    ctx.font = FONT_META;
    ctx.textAlign = 'right';
    ctx.fillStyle = PALETTE.PARCHMENT;
    const shown = fitText(ctx, value, w);
    ctx.fillText(shown, x + w, y + ROW_H / 2);
    const valueW = Math.ceil(ctx.measureText(shown).width);
    ctx.textAlign = 'left';
    ctx.font = FONT_BODY;
    ctx.fillStyle = PALETTE.BONE;
    ctx.fillText(fitText(ctx, label, Math.max(0, w - valueW - CHAR_W)), x, y + ROW_H / 2);
    y += ROW_H;
  };

  field('Life', `${option.maxHp}`);
  field(resourceLabel(option.resource.kind), `${option.resource.current}/${option.resource.max}`);
  y += 3;

  // --- the four talents, in HOTBAR ORDER -----------------------------------
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHEN THEY DO NOT ALL FIT, THE CARD SAYS SO — IT USED TO JUST STOP.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The loop below `break`s when the next row would cross `bottom`, and at the
   * 640x320 floor that is two of the four talents gone with nothing on screen
   * saying a fourth and third existed. This is the CLASS CHOICE: a player
   * picking between three classes off four talent names each was choosing on
   * half the information and had no way to know it.
   *
   * `ui/caselog.ts:467-478` is the rule -- a surface that has quietly stopped
   * showing everything says so in WORDS and never in a shade -- and the
   * character sheet's dropped sections already follow it. This is the same
   * concession made honest.
   *
   * THE NOTE COSTS A ROW, which is why `capacity - 1` is what gets drawn. That
   * is the right trade: "Lockdown" and a silent gap tells the player less than
   * "Ward Rush, Iron Curtain, +2 more", because the second one is complete about
   * what it is leaving out. Below one row there is nowhere to put the note and
   * nothing is claimed.
   */
  const capacity = Math.max(0, Math.floor((bottom - y) / TALENT_ROW_H));
  const total = option.talents.length;
  const shown = capacity >= total ? total : Math.max(0, capacity - 1);
  const talentsShown = option.talents.slice(0, shown);

  for (const talent of talentsShown) {
    if (y + TALENT_ROW_H > bottom) break;
    const box: PanelRect = {
      x,
      y: y + Math.floor((TALENT_ROW_H - TALENT_ICON) / 2),
      w: TALENT_ICON,
      h: TALENT_ICON,
    };
    if (!blitCropped(ctx, sprites, talent.icon, box)) {
      drawLetterPlate(ctx, box, initialsOf(talent.name), FONT_ICON_FALLBACK);
    }
    // The shorthand first, right-aligned, so the name is fitted to whatever is
    // actually left rather than to the whole card. Same order and same reason as
    // `field` above.
    const meta = talentShorthand(talent);
    ctx.font = FONT_BODY;
    ctx.textAlign = 'right';
    ctx.fillStyle = PALETTE.SLATE;
    const metaShown = fitText(ctx, meta, Math.max(0, w - TALENT_ICON - 4));
    ctx.fillText(metaShown, x + w, y + TALENT_ROW_H / 2);
    const metaW = Math.ceil(ctx.measureText(metaShown).width);
    ctx.textAlign = 'left';
    ctx.fillStyle = PALETTE.BONE;
    ctx.fillText(
      fitText(ctx, talent.name, Math.max(0, w - TALENT_ICON - 4 - metaW - CHAR_W)),
      x + TALENT_ICON + 4,
      y + TALENT_ROW_H / 2,
    );
    y += TALENT_ROW_H;
  }

  // THE WORDS, in the row `shown` gave up for them. Slate rather than bone: it
  // is a statement ABOUT the list, not another entry in it.
  if (shown < total && y + TALENT_ROW_H <= bottom) {
    ctx.font = FONT_BODY;
    ctx.textAlign = 'left';
    ctx.fillStyle = PALETTE.SLATE;
    ctx.fillText(
      fitText(ctx, `+${String(total - shown)} more`, w),
      x + TALENT_ICON + 4,
      y + TALENT_ROW_H / 2,
    );
  }
}

export type ClassPickerDrawOptions = {
  readonly ctx: CanvasRenderingContext2D;
  readonly sprites: SpriteSource;
  readonly rect: PanelRect;
  /** The server's list, in the server's order. Never sorted here. */
  readonly options: readonly ClassOptionView[];
  /** Index into `options`, or null while nothing is picked. */
  readonly selected: number | null;
  /** Index under the pointer, or null. */
  readonly hovered: number | null;
  /**
   * The origin list, in the server's order. EMPTY IS A REAL STATE, not a bug: a
   * server built before origins sends none, and the strip disappears entirely
   * rather than drawing an empty band.
   */
  readonly origins?: readonly OriginOptionView[];
  /** Index into `origins`. Never null once the strip is up — see main.ts. */
  readonly selectedOrigin?: number | null;
  /** Chip under the pointer, or null. */
  readonly hoveredOrigin?: number | null;
};

/**
 * ONE ORIGIN CHIP. The name, and the three-signal selection this file requires.
 *
 * SHAPE AND COLOUR HERE, THE WORD IN `originNoteText`. See that function for why
 * the word cannot live on the chip and why it has to live somewhere.
 */
function drawOriginChip(
  ctx: CanvasRenderingContext2D,
  origin: OriginOptionView,
  rect: PanelRect,
  selected: boolean,
  hovered: boolean,
): void {
  if (rect.w <= 0 || rect.h <= 0) return;

  ctx.fillStyle = selected ? PALETTE.SLATE : PALETTE.INK;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

  if (selected) {
    ctx.strokeStyle = PALETTE.GOLD;
    ctx.lineWidth = SELECT_BORDER;
    // INSET BY HALF THE LINE WIDTH, so a 2px stroke lands inside the chip
    // rather than straddling its edge and bleeding into the neighbour.
    ctx.strokeRect(
      rect.x + SELECT_BORDER / 2,
      rect.y + SELECT_BORDER / 2,
      rect.w - SELECT_BORDER,
      rect.h - SELECT_BORDER,
    );
  }

  ctx.font = FONT_META;
  ctx.fillStyle = selected ? PALETTE.GOLD : hovered ? PALETTE.PARCHMENT : PALETTE.GREY_HI;
  ctx.fillText(
    fitText(ctx, origin.name.toUpperCase(), rect.w - CARD_PAD * 2),
    rect.x + CARD_PAD,
    rect.y + rect.h / 2,
  );
}

/**
 * Paint the modal: the scrim, then the panel, then the cards, then the button.
 *
 * The scrim comes from `drawScrim` rather than being written here, because an
 * unwrapped `globalAlpha` leaks to every painter later in the frame and presents
 * as translucent sprites across the whole screen — see that helper's note.
 *
 * `save`/`restore` around everything and a clip to the panel rect, exactly as
 * the party pane and the card strip do: a long class description must never
 * bleed onto the map, even one that is behind a scrim.
 */
export function drawClassPicker(options: ClassPickerDrawOptions): void {
  const { ctx, sprites, rect, options: cards, selected, hovered } = options;
  if (rect.w <= 0 || rect.h <= 0) return;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  // THE SCRIM FIRST, sized from the CANVAS rather than from the rect: the modal
  // is not the whole viewport and the whole point of a scrim is everything it is
  // not. `ctx.canvas` here is the BACKBUFFER, whose size is exactly the logical
  // viewport and is never anything else (render/canvas.ts:581-584: "Exactly the
  // logical size, forever"), so this is the same number the hud painter is
  // handed — not a device-pixel size that would scrim a fraction of the screen.
  drawScrim(ctx, ctx.canvas.width, ctx.canvas.height);

  drawPanel(ctx, sprites, PanelSkin.CaseFile, rect);
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();

  drawHeader(ctx, sprites, PICKER_TITLE, rect, FONT_META);

  const origins = options.origins ?? [];
  const geometry = pickerGeometry(cards, rect, origins);

  ctx.font = FONT_BODY;
  ctx.fillStyle = PALETTE.GREY_HI;
  ctx.fillText(
    fitText(ctx, pickerHint(options.options.length, origins.length > 1), geometry.hint.w),
    geometry.hint.x,
    geometry.hint.y + HINT_H / 2,
  );

  // THE STRIP BEFORE THE CARDS, in reading order: an origin is what you were
  // before the class is what you became.
  for (let i = 0; i < origins.length; i += 1) {
    const origin = origins[i];
    const chip = geometry.origins[i];
    if (origin === undefined || chip === undefined) continue;
    drawOriginChip(ctx, origin, chip, options.selectedOrigin === i, options.hoveredOrigin === i);
  }
  const chosenOrigin =
    options.selectedOrigin === null || options.selectedOrigin === undefined
      ? undefined
      : origins[options.selectedOrigin];
  if (chosenOrigin !== undefined) {
    ctx.font = FONT_BODY;
    ctx.fillStyle = PALETTE.GREY_HI;
    ctx.fillText(
      fitText(ctx, originNoteText(chosenOrigin), geometry.originNote.w),
      geometry.originNote.x,
      geometry.originNote.y + ORIGIN_NOTE_H / 2,
    );
  }

  for (let i = 0; i < cards.length; i += 1) {
    const option = cards[i];
    const cardRect = geometry.cards[i];
    if (option === undefined || cardRect === undefined) continue;
    drawCard(ctx, sprites, option, cardRect, i, selected === i, hovered === i);
  }

  // DRAWN DISABLED-BUT-PRESENT when nothing is picked, never hidden. A button
  // that appears only once a card is chosen teaches nothing about what to do
  // next, which is the whole job of this screen — the same argument
  // ui/contextmenu.ts:82-90 makes for greying a row instead of dropping it.
  drawButton(ctx, geometry.confirm, CONFIRM_LABEL, {
    ink: selected === null ? PALETTE.GREY : PALETTE.GOLD,
  });

  ctx.restore();
}
