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
import { gameKeymap } from '../input/keys.ts';
import { labelFor } from '../input/keymap.ts';
import { drawPanel, fitText, PanelSkin } from './panel.ts';
import type { Keymap } from '../input/keymap.ts';
import type { SpriteSource } from '../render/assets.ts';
import type { PanelRect } from './panel.ts';

/** The heading. Short, so it survives any width. */
const HEADLINE = 'YOU ARE ERASED';

/**
 * THE KEY THAT REFILES YOU, AS THIS PLAYER'S KEYBOARD SPELLS IT TODAY.
 *
 * ═══ THIS USED TO BE THE LETTER F, WRITTEN INTO TWO STRINGS ═══
 * `respawn` is rebindable, so the letter is a DEFAULT and not a fact. A stale
 * mnemonic is worse here than anywhere else in the client: the person reading
 * this is stuck, cannot act, and is already unsure whether the game has frozen —
 * the keymap's own `respawn` row chose F for exactly that audience, "the only
 * key in the game a player will look for while reading a prompt rather than from
 * memory". Naming a key they have rebound would tell them to press something
 * that does nothing, at the moment they have least patience for it.
 *
 * `labelFor` gives every binding, joined; the first is the one to print, and it
 * is already '--' when there is genuinely none (KeyBind.lua:158-160's rule,
 * ported in keymap.ts). CLICKING THE PLATE STILL WORKS EITHER WAY, which is why
 * the sentence names both routes.
 */
function respawnKey(keymap: Keymap): string {
  return labelFor('respawn', keymap).split(' / ')[0] ?? '--';
}

/**
 * The instruction, and it names BOTH ways through.
 *
 * The key is named because a keyboard player should never have to touch the
 * mouse; the click is named because the plate is a button and an unlabelled
 * button is decoration. "Refile" is the game's own word — a body at 0 hp is
 * *Unfiled* — and the plain-English half follows it in the same sentence so
 * nobody has to have read the fiction to understand the instruction.
 */
function instruction(keymap: Keymap): string {
  return `press ${respawnKey(keymap)} — or click here — to refile yourself`;
}

const PROMPT_W = 304;
const PROMPT_H = 48;
const BORDER = 2;

const FONT_HEAD = 'bold 12px ui-monospace, Consolas, monospace';
const FONT_BODY = '10px ui-monospace, Consolas, monospace';

/**
 * The text the status line and the aria-live region say. One copy, two surfaces.
 *
 * ═══ THIS IS THE SENTENCE A SCREEN READER SPEAKS, SO IT IS THE ONE THAT MOST
 *     HAS TO BE TRUE ═══
 * A sighted player can at least see the plate; somebody hearing this has nothing
 * else, so a key that has been rebound out from under it leaves them pressing a
 * letter that does nothing with no way to discover as much.
 */
export function respawnPromptSpeech(keymap: Keymap = gameKeymap.current): string {
  return `ERASED — press ${respawnKey(keymap)} to refile yourself and get back up`;
}

/**
 * The same sentence with the SHIPPED default in it, evaluated once at module
 * load.
 *
 * IT EXISTS ONLY SO main.ts'S CURRENT CALL SITE STILL COMPILES, and it is the
 * stale one by construction: a string cannot follow a rebind. The live answer is
 * `respawnPromptSpeech()` above, and the aria-live region must move onto it —
 * main.ts:2440 is the single reader.
 */
export const RESPAWN_PROMPT_SPEECH = respawnPromptSpeech();

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
  /**
   * The player's compiled keymap, so the instruction names the LIVE key.
   * Optional and defaulted to `gameKeymap.current`, the box `bindGameKeys`
   * already dereferences on every press — so main.ts's call site needed no
   * change and the prompt cannot disagree with the dispatcher.
   */
  readonly keymap?: Keymap;
}): void {
  const { ctx, sprites, rect, hovered } = options;
  const keymap = options.keymap ?? gameKeymap.current;
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
  ctx.fillText(fitText(ctx, instruction(keymap), inner.w - 8), midX, rect.y + 33);

  ctx.restore();
}
