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
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IT COVERS BOTH STAGES NOW, AND IT USED TO COVER ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This plate was gated on ERASED alone, so a player who died saw NOTHING on the
 * canvas for the five turns that decide whether the run continues — the loudest
 * moment in the game, and the screen said nothing. The countdown existed only in
 * the party pane, which toggles off with `p` and sheds its digits on a narrow
 * window, and in the Case Log, which is a transcript a dying player is not
 * reading.
 *
 * The two stages want opposite sentences and that is the whole reason they are
 * one surface rather than two:
 *
 *   DOWN    — a clock is running and somebody may reach you. The respawn key is
 *             REFUSED here (main.ts's `attemptRespawn` says so), so advertising
 *             it would be an instruction that does not work.
 *   ERASED  — nothing is coming. The key is the only thing that does anything,
 *             and it is the only state it works in.
 *   WIPED   — it is already over. The floor has reset and the body is back on
 *             its feet at full hp, so there is nothing to wait for and nothing
 *             to press; the plate is the only record the PLAYER gets that they
 *             died at all.
 *
 * ═══ AND `WIPED` IS THE ONLY STAGE A SOLO PLAYER EVER REACHES ═══
 * A party wipe fires the instant nobody is left standing, and one player alone
 * IS the whole party — so their death and their wipe are the same event, raised
 * inside a single pump. `resetFloorParty` calls `standUp`, which does
 * `state.byActor.delete(actor.id)`, and the record is gone before the `party`
 * frame at the end of that pump is ever projected.
 *
 * So a plate driven off `PartyMember.downed` — which is what the first two
 * stages are — CANNOT DRAW A SINGLE FRAME for a player who dies by themselves,
 * or for anybody on a party wipe. It is not a timing window that could be
 * widened: the record never reaches the wire in that state at all. This stage
 * is driven by the `erased` event instead (`ErasedReason.Wipe`), which is the
 * one thing that does arrive.
 */
export const DeathStage = {
  Down: 'down',
  Erased: 'erased',
  Wiped: 'wiped',
} as const;
export type DeathStage = (typeof DeathStage)[keyof typeof DeathStage];

/** What the plate is about. Everything else on it follows from this. */
export type DeathView = {
  readonly stage: DeathStage;
  /** Game turns until Erased. Only read on `Down`. */
  readonly turnsLeft: number;
  /** What put them there, or null when nothing can be named. */
  readonly by: string | null;
  /**
   * Is anybody else still standing on this floor?
   *
   * THE SAME DISTINCTION THE CASE LOG ALREADY MAKES, and for the reason it
   * records at length: "turns to reach them" is addressed to somebody, and read
   * by a player alone it is an instruction about help that is not coming. The
   * countdown is the same countdown; what it MEANS is not.
   */
  readonly rescuers: boolean;
};

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

/**
 * THE SAME KEY, DOING THE ONLY THING LEFT TO DO.
 *
 * Not a second binding. The keymap owns what a key DOES and this file does not
 * get a second opinion about it (main.ts's `keydown` listener says so at
 * length), so the dismissal rides the key the player is already told about in
 * the state next door — and `attemptRespawn` branches on the stage rather than
 * the wire deciding twice.
 */
function dismissal(keymap: Keymap): string {
  return `the floor has reset — press ${respawnKey(keymap)}, or click here`;
}

/**
 * The headline. One word of state, and it is the word the game uses.
 *
 * WIPED READS `ERASED` TOO, because that is what the Record lane calls it in the
 * same breath — *"X is erased — nobody is left standing. The floor resets."* Two
 * vocabularies for one event would make the plate and the transcript look like
 * they are describing different deaths.
 */
export function deathHeadline(view: DeathView): string {
  return view.stage === DeathStage.Down ? 'YOU ARE DOWN' : 'YOU ARE ERASED';
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT PUT YOU HERE — its own line, or empty when nothing can be named.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `DownedEvent.sourceId` has been on the wire, declared and documented, with
 * nothing filling it. "You are down" with no cause is the one sentence a player
 * is guaranteed to read carefully and guaranteed to learn nothing from — and the
 * blow that did it is in the transcript, which is exactly where they are not
 * looking.
 *
 * ═══ ITS OWN LINE RATHER THAN A PREFIX, AND THAT IS A MEASUREMENT ═══
 * Folded into the sentence below it, "Index Husk put you here · press F — or
 * click here — to refile yourself" is about seventy characters against the
 * plate's forty-eight, so `fitText` would have ellipsised — cutting off either
 * the cause that was just added or the instruction that is the only way out.
 * A third line costs sixteen pixels of a plate nothing else competes with.
 *
 * EMPTY IS A REAL ANSWER. A body that bled out from an effect whose source is
 * gone has nobody to name, and the plate simply loses a line rather than
 * inventing one.
 */
export function deathCause(view: DeathView): string {
  return view.by === null ? '' : `${view.by} put you here`;
}

/**
 * The last line: what happens next. A clock while a clock is running, and the
 * only key that works once it has stopped.
 */
export function deathAction(view: DeathView, keymap: Keymap = gameKeymap.current): string {
  /**
   * ═══ THE WIPE SENTENCE IS PAST TENSE, AND THAT IS THE POINT ═══
   * The other two stages describe something that has not finished. This one
   * describes something that already has: by the time this plate can be drawn
   * the floor is rebuilt and the body is standing on it at full hp. Telling the
   * player to press a key to be restored would be an instruction to do a thing
   * the server did without asking.
   *
   * It still names a key, because the plate has to go away and a plate that
   * dismisses itself on a timer is one a player who looked away never reads.
   */
  if (view.stage === DeathStage.Wiped) return dismissal(keymap);
  if (view.stage === DeathStage.Erased) return instruction(keymap);

  const turns = Math.max(0, Math.floor(view.turnsLeft));
  if (turns === 1) {
    return view.rescuers ? 'one turn for an ally to reach you' : 'one turn, and nobody is coming';
  }
  return view.rescuers
    ? `${String(turns)} turns for an ally to reach you`
    : `${String(turns)} turns, and nobody is coming`;
}

const PROMPT_W = 304;
/**
 * 48 -> 66 FOR THE CAUSE LINE. Measured rather than nudged: the head sits at
 * +16 and the two body lines at +33 and +49, and the border and the panel's own
 * inset want the rest. See `deathCause` for why it is a line and not a prefix.
 */
const PROMPT_H = 66;
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
 * main.ts:2781 is the single reader.
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
  /**
   * WHICH STAGE, AND WHAT TO SAY ABOUT IT.
   *
   * OPTIONAL, defaulting to the Erased shape this plate had before it covered
   * both — so a caller that predates the split still gets exactly the surface it
   * has always drawn rather than a blank one.
   */
  readonly view?: DeathView;
}): void {
  const { ctx, sprites, rect, hovered } = options;
  const keymap = options.keymap ?? gameKeymap.current;
  const view: DeathView = options.view ?? {
    stage: DeathStage.Erased,
    turnsLeft: 0,
    by: null,
    rescuers: false,
  };
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
  ctx.fillText(fitText(ctx, deathHeadline(view), inner.w - 8), midX, rect.y + 16);

  ctx.font = FONT_BODY;
  ctx.fillStyle = PALETTE.GOLD;
  /**
   * THE CAUSE, THEN THE CLOCK. A plate with nothing to name simply loses the
   * middle line and the action moves up into its place — so a death with no
   * culprit reads as the tight two-line plate this surface has always been
   * rather than as one with a hole in it.
   */
  const cause = deathCause(view);
  if (cause !== '') {
    ctx.fillText(fitText(ctx, cause, inner.w - 8), midX, rect.y + 33);
  }
  ctx.fillText(
    fitText(ctx, deathAction(view, keymap), inner.w - 8),
    midX,
    cause === '' ? rect.y + 33 : rect.y + 49,
  );

  ctx.restore();
}
