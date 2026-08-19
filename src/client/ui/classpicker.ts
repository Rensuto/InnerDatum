/**
 * THE CLASS CHOOSER: the first screen a new player ever sees, and the only
 * genuinely modal surface in this client.
 *
 * ===========================================================================
 * IT IS ToME'S BIRTHER, REDUCED TO WHAT THIS GAME ACTUALLY HAS
 * ===========================================================================
 * `dialogs/Birther.lua` builds its subclass list as a `TreeList` of
 * `display_prop="name"` rows carrying a 32px class icon (`setSubclassIcon`,
 * Birther.lua:46-56; the list at :131-140), and pushes the SELECTED item's
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
 * Everything ToME's birther has that we do not — races, sex, difficulty,
 * permadeath, campaign, stat rolls, a name field — is ABSENT rather than shown
 * disabled. There is exactly one decision on this screen.
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
 * (`t.name:lower():gsub("[^a-z0-9]", "_")`, Birther.lua:47-48) and survives a
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
import type { ClassOptionView, LoadoutTalent } from '../../shared/protocol.ts';
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

/** Preferred size of the modal, and the air it leaves around itself. */
const PICKER_W = 560;
const PICKER_H = 340;
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
/** How many sentences of `description` a card will show before truncating. */
const DESC_MAX_LINES = 4;

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
const PICKER_HINT = 'pick with 1-3 or the arrows · Enter confirms · this choice is permanent';
const CONFIRM_LABEL = 'CONFIRM';
/** The word half of the selection mark. See the header: never colour alone. */
const SELECTED_WORD = 'SELECTED';

// ---------------------------------------------------------------------------
// Hit results
// ---------------------------------------------------------------------------

export const ClassPickerHitKind = {
  Card: 'card',
  Confirm: 'confirm',
} as const;
export type ClassPickerHitKind = (typeof ClassPickerHitKind)[keyof typeof ClassPickerHitKind];

export type ClassPickerHit =
  | { readonly kind: typeof ClassPickerHitKind.Card; readonly index: number }
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
export function classPickerRect(width: number, height: number): PanelRect {
  const w = Math.max(0, Math.min(PICKER_W, width - PICKER_MARGIN * 2));
  const h = Math.max(0, Math.min(PICKER_H, height - PICKER_MARGIN * 2));
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
function pickerGeometry(options: readonly ClassOptionView[], rect: PanelRect): PickerGeometry {
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

  const cardsTop = top + HINT_H;
  const cardsH = Math.max(0, confirm.y - CONFIRM_GAP - cardsTop);
  const count = options.length;
  if (count === 0 || cardsH <= 0) return { cards: [], confirm, hint };

  const cardW = Math.floor((innerW - CARD_GAP * (count - 1)) / count);
  const cards: PanelRect[] = [];
  for (let i = 0; i < count; i += 1) {
    cards.push({ x: x + i * (cardW + CARD_GAP), y: cardsTop, w: Math.max(0, cardW), h: cardsH });
  }
  return { cards, confirm, hint };
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
): readonly PanelRect[] {
  return pickerGeometry(options, rect).cards;
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
): ClassPickerHit | null {
  const inside = (r: PanelRect): boolean =>
    px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;

  const geometry = pickerGeometry(options, rect);
  if (inside(geometry.confirm)) return { kind: ClassPickerHitKind.Confirm };
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
  for (let i = 0; i < lines.length && i < DESC_MAX_LINES; i += 1) {
    const line = lines[i];
    if (line === undefined || y + ROW_H > bottom) break;
    // The last line this card can show gets an ellipsis when there is more,
    // rather than stopping mid-sentence as though the text simply ended.
    const more = i === DESC_MAX_LINES - 1 && lines.length > DESC_MAX_LINES;
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
  for (const talent of option.talents) {
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
};

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

  const geometry = pickerGeometry(cards, rect);

  ctx.font = FONT_BODY;
  ctx.fillStyle = PALETTE.GREY_HI;
  ctx.fillText(
    fitText(ctx, PICKER_HINT, geometry.hint.w),
    geometry.hint.x,
    geometry.hint.y + HINT_H / 2,
  );

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
