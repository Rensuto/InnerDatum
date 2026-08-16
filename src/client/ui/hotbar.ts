/**
 * The hotbar: four slots, keys 1-4, a 64x64 icon inside a 72x72 frame.
 *
 * ===========================================================================
 * FOUR SLOTS, AND THAT IS THE WHOLE UI
 * ===========================================================================
 * PLAN.md capped the MVP at twelve talents, four per class, and this header
 * used to go on to say "with ZERO talent trees, ZERO talent points and FIXED
 * loadouts — M6 owns progression". THAT IS NO LONGER TRUE and the past tense is
 * deliberate: talent points exist, are spent through `spend_point`, are
 * persisted, and are on the wire. M6 shipped.
 *
 * WHAT DID NOT CHANGE FOR THIS FILE, WHICH IS WHY IT STILL DRAWS FOUR: a point
 * DEEPENS one of the four rather than adding a fifth, so the bar is still the
 * class itself rather than a container the player fills, and there is still
 * deliberately no drag-and-drop, no page 2, no empty-slot state and no binding
 * UI.
 *
 * WHAT DID CHANGE, so the next reader does not file a rank indicator as blocked
 * on a milestone that has already landed: `LoadoutTalent` gained REQUIRED
 * `level` and `maxLevel` fields at protocol v9, both of them populated on every
 * frame this file receives. A rank badge on a slot is a live option today; it is
 * simply not drawn yet, because the talent panel behind `g` is where a rank is
 * currently read. `LoadoutMsg.talents` arrives in hotbar order and this file NEVER sorts it:
 * muscle memory for which key is Ward Rush is worth more than any ordering a
 * renderer could impose, and a hotbar that re-sorted by cooldown would move the
 * buttons around mid-fight.
 *
 * ===========================================================================
 * THE COOLDOWN WIPE IS DRAWN, NOT BLITTED
 * ===========================================================================
 * A canvas wedge — `arc` from twelve o'clock, clockwise, at a fixed alpha over
 * the icon — plus the turns remaining as a number on top. Not an image asset,
 * for three reasons that all matter:
 *
 *   1. A cooldown is a FRACTION of `LoadoutTalent.cooldownTurns`, and a 5-turn
 *      talent at 2 turns left is 40%. Art would need a frame per step per
 *      talent, or one generic wipe that lies about every talent whose cooldown
 *      is not the length the art assumed.
 *   2. It steps once per GAME TURN, because that is when the number actually
 *      changes. There is no animation and there must not be one: a smoothly
 *      sweeping wedge implies a continuous quantity and this one is discrete, so
 *      a sweep would be an animation lying about arithmetic — and PLAN.md § 10
 *      lists animation playback under Never.
 *   3. The NUMBER is the real signal and the wedge is the glanceable one. Both
 *      are drawn, always, so nobody has to count pixels of arc to know whether
 *      Mend Wounds comes back this turn or next.
 *
 * ===========================================================================
 * DISABLED IS A HATCH, NOT A TINT
 * ===========================================================================
 * `ui_hotbar_slot_disabled` already carries a diagonal hatch across the frame,
 * and that is why the disabled state uses the art instead of drawing the idle
 * frame darker. State is never signalled by colour alone here — the same rule
 * that gives the turn chips four silhouettes and the pips three. A slot is
 * disabled when the cooldown is live OR the resource is short, and both cases
 * additionally say so in words: the wipe carries digits, and the cost readout
 * turns from BONE to ORANGE when it cannot be paid.
 *
 * ALL OF IT IS ADVISORY. Affordability is computed here from the last `resource`
 * frame purely so the button can be greyed; the server re-checks the cost and
 * the cooldown on arrival and answers with `no_resource` or `on_cooldown`. A
 * greyed slot still sends its frame if the key is pressed — see main.ts. A
 * client that refuses to send is a client with a second copy of the rules, and
 * the moment the two disagree the player is holding a button that does nothing
 * and cannot be told why.
 *
 * IT DRAWS INTO THE BACKBUFFER through `Scene.hud`, at logical scale, exactly
 * like the party strip — so the frames are magnified by the same integer factor
 * as the world and sit on the same pixel grid. See the long note at the top of
 * render/canvas.ts.
 */

import { PALETTE } from '../render/canvas.ts';
import type { LoadoutTalent } from '../../shared/protocol.ts';
import type { SpriteSource } from '../render/assets.ts';

/** The authored frame size. `ui_hotbar_slot_*` are all 72x72. */
export const SLOT_PX = 72;
/** The authored icon size. `ui/icons/abilities/*` are 64x64. */
const ICON_PX = 64;
const SLOT_GAP = 4;
const SLOT_PAD = 4;

/**
 * Vertical bite the hotbar takes out of the bottom of the viewport.
 *
 * It OVERLAYS the world rather than shrinking the camera, the same way the party
 * strip overlays the top. The cost is real — 80 of 480 logical pixels, about two
 * and a half tile rows — and it is accepted rather than worked around, because
 * the alternative is drawing 72x72 art at some fractional scale, which is
 * precisely the resampling the whole backbuffer exists to prevent. The camera
 * centres on the player, so the tile that matters most is never underneath it.
 */
export const HOTBAR_H = SLOT_PX + SLOT_PAD * 2;

/** The one-line talent name above the row. */
export const HOTBAR_LABEL_H = 14;

/**
 * Everything the hotbar occupies, so main.ts can stack the resource pips and the
 * notice line above it without either guessing the other's height. Exported for
 * exactly that: two files agreeing on a layout by arithmetic rather than by two
 * hard-coded numbers that drift the first time a slot changes size.
 */
export const HOTBAR_TOTAL_H = HOTBAR_H + HOTBAR_LABEL_H;

/** How dark the cooldown wedge goes. Dark enough to read, light enough to identify the icon. */
const WIPE_ALPHA = 0.72;
/** Half the diagonal of a 64px square, rounded up: the wedge must cover the corners. */
const WIPE_RADIUS = 46;

const FONT_KEY = 'bold 10px ui-monospace, Consolas, monospace';
const FONT_COST = '10px ui-monospace, Consolas, monospace';
const FONT_WIPE = 'bold 20px ui-monospace, Consolas, monospace';
const FONT_NAME = '10px ui-monospace, Consolas, monospace';

/** One slot's live state, assembled by main.ts from three separate frames. */
export type HotbarSlot = {
  readonly talent: LoadoutTalent;
  /** GAME TURNS remaining. 0 is ready — the `cooldowns` frame omits ready talents. */
  readonly cooldown: number;
  /** Advisory: the last `resource` frame says this is payable. */
  readonly affordable: boolean;
};

export type HotbarView = {
  /** In server order. Never sorted here. Empty until `loadout` arrives. */
  readonly slots: readonly HotbarSlot[];
  /** Index under the pointer, or -1. */
  readonly hovered: number;
  /** Index currently in targeting mode, or -1. */
  readonly armed: number;
};

export type HotbarOptions = {
  readonly ctx: CanvasRenderingContext2D;
  readonly sprites: SpriteSource;
  readonly view: HotbarView;
  /** Logical backbuffer size, in world pixels — not device pixels. */
  readonly width: number;
  readonly height: number;
};

export type SlotRect = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

/**
 * Where slot `index` sits, given the viewport.
 *
 * ONE function, used by the painter AND by the hit test, so a click can never
 * land on a slot other than the one under the pointer. Two copies of this
 * arithmetic is the classic way a UI acquires an off-by-four-pixels bug that
 * only shows up on somebody else's window size.
 */
export function slotRect(index: number, count: number, width: number, height: number): SlotRect {
  const rowW = count * SLOT_PX + Math.max(0, count - 1) * SLOT_GAP;
  const x0 = Math.floor((width - rowW) / 2);
  return {
    x: x0 + index * (SLOT_PX + SLOT_GAP),
    y: height - HOTBAR_H + SLOT_PAD,
    w: SLOT_PX,
    h: SLOT_PX,
  };
}

/**
 * Which slot a logical-backbuffer point is over, or -1.
 *
 * Takes BACKBUFFER coordinates, not client ones: the caller converts once, using
 * the renderer's metrics, and everything downstream of that conversion works in
 * the one coordinate space the HUD is drawn in.
 */
export function hotbarSlotAt(
  px: number,
  py: number,
  count: number,
  width: number,
  height: number,
): number {
  for (let i = 0; i < count; i += 1) {
    const r = slotRect(i, count, width, height);
    if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) return i;
  }
  return -1;
}

/** A slot is dead when the cooldown is live or the cost cannot be paid. */
export function isSlotDisabled(slot: HotbarSlot): boolean {
  return slot.cooldown > 0 || !slot.affordable;
}

/** Trim to fit, with an ellipsis. Talent names are authored, but not by this file. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxPx: number): string {
  if (maxPx <= 0) return '';
  if (ctx.measureText(text).width <= maxPx) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxPx) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * The icon, or initials.
 *
 * The initials fallback is not decoration. There are no ability PNGs in the
 * placeholder manifest yet, so on today's build EVERY slot takes this path — and
 * four identical violet error boxes would make the hotbar unusable exactly while
 * the art pipeline is catching up. Two letters keep the four buttons
 * distinguishable, which is all the hotbar has to be.
 */
function drawIcon(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  talent: LoadoutTalent,
  x: number,
  y: number,
): void {
  const sprite = sprites.sprite(talent.icon);
  if (sprite !== undefined) {
    ctx.drawImage(sprite.image, x, y, sprite.w, sprite.h);
    return;
  }

  ctx.fillStyle = PALETTE.VOID;
  ctx.fillRect(x, y, ICON_PX, ICON_PX);
  ctx.fillStyle = PALETTE.SILVER;
  ctx.font = FONT_WIPE;
  ctx.textAlign = 'center';
  const initials = talent.name
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase())
    .join('')
    .slice(0, 2);
  ctx.fillText(initials, x + ICON_PX / 2, y + ICON_PX / 2);
  ctx.textAlign = 'left';
}

/**
 * THE WIPE. A clockwise wedge from twelve o'clock covering `remaining / total`
 * of the icon, then the number.
 *
 * CLIPPED to the icon square, which is why `WIPE_RADIUS` may exceed the icon's
 * half-width: the wedge has to reach the corners of a square, so it is drawn on
 * a circle big enough to cover them and cut back to the box. Without the clip the
 * wedge spills over the frame art and the slot loses its border on three sides
 * out of four, depending on the fraction.
 *
 * `total <= 0` cannot normally happen (a talent with no cooldown never appears
 * in the `cooldowns` frame) but is treated as a FULL wipe rather than a division
 * by zero, so a content bug reads as "this talent is unavailable" instead of
 * painting NaN.
 */
function drawCooldownWipe(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  remaining: number,
  total: number,
): void {
  const fraction = total > 0 ? Math.min(1, Math.max(0, remaining / total)) : 1;
  const cx = x + ICON_PX / 2;
  const cy = y + ICON_PX / 2;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, ICON_PX, ICON_PX);
  ctx.clip();

  ctx.globalAlpha = WIPE_ALPHA;
  ctx.fillStyle = PALETTE.INK;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  // -PI/2 is twelve o'clock; sweeping positive is clockwise on a canvas, whose
  // y axis points down.
  ctx.arc(cx, cy, WIPE_RADIUS, -Math.PI / 2, -Math.PI / 2 + fraction * Math.PI * 2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // The digits, over the wedge. Outlined so they stay legible against both the
  // darkened half of the icon and the undarkened half.
  const digits = `${Math.ceil(remaining)}`;
  ctx.save();
  ctx.font = FONT_WIPE;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.strokeStyle = PALETTE.INK;
  ctx.strokeText(digits, cx, cy);
  ctx.fillStyle = PALETTE.GOLD;
  ctx.fillText(digits, cx, cy);
  ctx.restore();
}

/**
 * Which frame art a slot wears.
 *
 * Disabled outranks hover and armed: a slot you cannot press must not light up
 * when the pointer crosses it, because a lit button that does nothing is worse
 * than a dead one that looks dead.
 */
function frameIdFor(slot: HotbarSlot, hovered: boolean, armed: boolean): string {
  if (isSlotDisabled(slot)) return 'ui_hotbar_slot_disabled';
  if (hovered || armed) return 'ui_hotbar_slot_hover';
  return 'ui_hotbar_slot_idle';
}

/** The frame, or a traced box, so a missing PNG never removes the button. */
function drawFrame(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  id: string,
  rect: SlotRect,
): void {
  const sprite = sprites.sprite(id);
  if (sprite !== undefined) {
    ctx.drawImage(sprite.image, rect.x, rect.y, sprite.w, sprite.h);
    return;
  }
  ctx.fillStyle = PALETTE.PANEL;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.fillStyle = PALETTE.SLATE;
  ctx.fillRect(rect.x, rect.y, rect.w, 1);
  ctx.fillRect(rect.x, rect.y + rect.h - 1, rect.w, 1);
  ctx.fillRect(rect.x, rect.y, 1, rect.h);
  ctx.fillRect(rect.x + rect.w - 1, rect.y, 1, rect.h);
}

/**
 * Paint the bar.
 *
 * Wrapped in save/restore because it changes `font`, `textAlign`,
 * `textBaseline`, `globalAlpha`, `lineWidth` and the clip — none of which the
 * world painter re-sets before every call, so a leak would show up three
 * milestones from now as a mysteriously translucent sprite.
 */
export function drawHotbar(options: HotbarOptions): void {
  const { ctx, sprites, view, width, height } = options;
  const count = view.slots.length;
  if (count === 0) return;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  // A backing strip, so the buttons never sit directly on a floor tile and lose
  // their edges against it.
  ctx.fillStyle = PALETTE.PANEL;
  ctx.fillRect(0, height - HOTBAR_H, width, HOTBAR_H);
  ctx.fillStyle = PALETTE.SLATE;
  ctx.fillRect(0, height - HOTBAR_H, width, 1);

  for (let i = 0; i < count; i += 1) {
    const slot = view.slots[i];
    if (slot === undefined) continue;

    const rect = slotRect(i, count, width, height);
    if (rect.x < 0 || rect.x + rect.w > width) continue;

    const armed = view.armed === i;
    drawFrame(ctx, sprites, frameIdFor(slot, view.hovered === i, armed), rect);

    const iconX = rect.x + Math.round((SLOT_PX - ICON_PX) / 2);
    const iconY = rect.y + Math.round((SLOT_PX - ICON_PX) / 2);
    drawIcon(ctx, sprites, slot.talent, iconX, iconY);

    if (slot.cooldown > 0) {
      drawCooldownWipe(ctx, iconX, iconY, slot.cooldown, slot.talent.cooldownTurns);
    }

    // THE ARMED RING. A gold border around the slot whose targeting mode is
    // open, so "which button am I aiming?" is answerable without reading the
    // hint line. Two pixels, drawn over the frame art rather than replacing it.
    if (armed) {
      ctx.fillStyle = PALETTE.GOLD;
      ctx.fillRect(rect.x, rect.y, rect.w, 2);
      ctx.fillRect(rect.x, rect.y + rect.h - 2, rect.w, 2);
      ctx.fillRect(rect.x, rect.y, 2, rect.h);
      ctx.fillRect(rect.x + rect.w - 2, rect.y, 2, rect.h);
    }

    // The key number, top-left. This is the label that actually gets used —
    // nobody clicks a hotbar in a keyboard game, they press 2.
    ctx.font = FONT_KEY;
    ctx.fillStyle = PALETTE.PARCHMENT;
    ctx.fillText(`${i + 1}`, rect.x + 5, rect.y + 8);

    // The cost, bottom-right, in ORANGE when it cannot be paid — a second,
    // worded signal beside the hatched frame, for the same reason the turn chips
    // carry names.
    //
    // AP IS THE NUMBER SHOWN, and the class resource only when the talent
    // spends no AP. game-design.md § 2 writes every talent as "AP 5" or
    // "AP 4, MP 1", so AP is the cost a player has learned to look for; the
    // resource pips under the row already answer "can I afford the reagent".
    // Two numbers in a 32-pixel corner is unreadable at any font size.
    const shown = slot.talent.cost.ap > 0 ? slot.talent.cost.ap : slot.talent.cost.resource;
    if (shown > 0) {
      ctx.font = FONT_COST;
      ctx.textAlign = 'right';
      ctx.fillStyle = slot.affordable ? PALETTE.BONE : PALETTE.ORANGE;
      ctx.fillText(`${shown}`, rect.x + rect.w - 5, rect.y + rect.h - 8);
      ctx.textAlign = 'left';
    }
  }

  // The name of whatever the pointer or the targeting mode is on, under the row.
  // One line, and only when there is something to say — a permanently occupied
  // line of prose becomes furniture and stops being read.
  const focused = view.armed >= 0 ? view.armed : view.hovered;
  const slot = focused >= 0 ? view.slots[focused] : undefined;
  if (slot !== undefined) {
    ctx.font = FONT_NAME;
    ctx.fillStyle = PALETTE.GOLD;
    const label = `${focused + 1}. ${slot.talent.name}`;
    ctx.fillText(fitText(ctx, label, width - 8), 4, height - HOTBAR_H - 7);
  }

  ctx.restore();
}
