/**
 * THE ERASED PROMPT: the one surface in the game aimed at a player who is
 * currently unable to do anything at all.
 *
 * ===========================================================================
 * WHY IT IS THIS LOUD
 * ===========================================================================
 * From the first real co-op session:
 *
 *   *"when the player dies, we need a respawn method as I was stuck since the
 *     other player's character is there."*
 *
 * That player sat inside Erased for the rest of an evening. The engine half of
 * the fix is in src/server/engine/downed.ts (`respawn`) and the wire half is the
 * `respawn` frame; this is the half that TELLS THEM. And the person who needs it
 * is by definition stuck, staring at a screen where nothing is happening,
 * pressing keys that are all refused — which is indistinguishable from a dropped
 * connection. A hint tucked in with the targeting prose is not enough for that
 * audience, so this is a plate in the middle of the map with a border on it.
 *
 * IT IS ALSO A BUTTON. The keyboard is the primary input everywhere else in this
 * client and stays that way, but somebody who believes the game has frozen
 * reaches for the mouse. Making the thing that is obviously a message ALSO the
 * thing that fixes it costs one hit test and removes the last way to be stuck.
 *
 * ===========================================================================
 * NO ANIMATION, DELIBERATELY
 * ===========================================================================
 * A pulse or a flash would need a sixth timer, and main.ts's header can state
 * exactly how many bounded timers this client runs — that list is a promise, not
 * a comment. A 2px crimson border, a dark plate and gold text are already the
 * loudest static thing on the screen, and they cost one frame.
 */

import { PALETTE } from '../render/canvas.ts';
import { drawPanel, fitText, PanelSkin } from './panel.ts';
import type { SpriteSource } from '../render/assets.ts';
import type { PanelRect } from './panel.ts';

/** The heading. Short, so it survives any width. */
const HEADLINE = 'YOU ARE ERASED';
/**
 * The instruction, and it names BOTH ways through.
 *
 * The key is named because a keyboard player should never have to touch the
 * mouse; the click is named because the plate is a button and an unlabelled
 * button is decoration. "Refile" is the game's own word — a body at 0 hp is
 * *Unfiled* — and the plain-English half follows it in the same sentence so
 * nobody has to have read the fiction to understand the instruction.
 */
const INSTRUCTION = 'press F — or click here — to refile yourself';

const PROMPT_W = 304;
const PROMPT_H = 48;
const BORDER = 2;

const FONT_HEAD = 'bold 12px ui-monospace, Consolas, monospace';
const FONT_BODY = '10px ui-monospace, Consolas, monospace';

/** The text the status line and the aria-live region say. One copy, two surfaces. */
export const RESPAWN_PROMPT_SPEECH = 'ERASED — press F to refile yourself and get back up';

/**
 * WHERE THE PLATE GOES, or null when the band it would sit in is too small.
 *
 * ONE function, called by the painter AND by the click test in main.ts, for the
 * same reason `slotRect` is in ui/hotbar.ts: two copies of this arithmetic is a
 * button that is drawn in one place and pressed in another.
 *
 * IN THE UPPER THIRD OF THE MAP BAND rather than dead centre, because dead
 * centre is where the camera keeps the player's own body — the prompt would
 * cover the very token it is talking about.
 */
export function respawnPromptRect(options: {
  /** Logical backbuffer width, in world pixels — not device pixels. */
  readonly width: number;
  /** First free pixel under the top HUD. */
  readonly top: number;
  /** First pixel of the bottom bands. */
  readonly bottom: number;
}): PanelRect | null {
  const { width, top, bottom } = options;
  const band = bottom - top;
  if (band < PROMPT_H + 8 || width < 160) return null;

  const w = Math.min(PROMPT_W, width - 24);
  return {
    x: Math.floor((width - w) / 2),
    y: top + Math.max(4, Math.floor((band - PROMPT_H) / 3)),
    w,
    h: PROMPT_H,
  };
}

/** True when a LOGICAL backbuffer point is on the plate. */
export function respawnPromptHit(rect: PanelRect | null, px: number, py: number): boolean {
  if (rect === null) return false;
  return px >= rect.x && px < rect.x + rect.w && py >= rect.y && py < rect.y + rect.h;
}

/**
 * Paint it.
 *
 * The crimson border is the same colour the playfield frame uses for "the fight
 * is on" and the turn cards use for "that one is on the floor" — one alarm
 * colour, three surfaces, and here it is a 2px ring around a plate rather than a
 * ring around the world, so the two can never be read as the same statement.
 * Colour is never the whole signal anyway: the words say it outright.
 */
export function drawRespawnPrompt(options: {
  readonly ctx: CanvasRenderingContext2D;
  readonly sprites: SpriteSource;
  readonly rect: PanelRect;
  /** Highlighted while the pointer is over it, so it reads as pressable. */
  readonly hovered: boolean;
}): void {
  const { ctx, sprites, rect, hovered } = options;
  if (rect.w <= 0 || rect.h <= 0) return;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // The border is the outer rect painted flat with the panel drawn inside it —
  // four fillRects' worth of arithmetic avoided, and it cannot leave a
  // one-pixel seam at a corner the way four strips can.
  ctx.fillStyle = PALETTE.CRIMSON;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  const inner: PanelRect = {
    x: rect.x + BORDER,
    y: rect.y + BORDER,
    w: rect.w - BORDER * 2,
    h: rect.h - BORDER * 2,
  };
  drawPanel(ctx, sprites, PanelSkin.CaseFile, inner);
  ctx.fillStyle = PALETTE.INK;
  ctx.globalAlpha = hovered ? 0.5 : 0.72;
  ctx.fillRect(inner.x, inner.y, inner.w, inner.h);
  ctx.globalAlpha = 1;

  const midX = rect.x + Math.floor(rect.w / 2);
  ctx.font = FONT_HEAD;
  ctx.fillStyle = PALETTE.PARCHMENT;
  ctx.fillText(fitText(ctx, HEADLINE, inner.w - 8), midX, rect.y + 16);

  ctx.font = FONT_BODY;
  ctx.fillStyle = PALETTE.GOLD;
  ctx.fillText(fitText(ctx, INSTRUCTION, inner.w - 8), midX, rect.y + 33);

  ctx.restore();
}
