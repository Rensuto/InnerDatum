/**
 * THE PURSE, ON FURNITURE THAT IS ALWAYS THERE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IT PORTS
 * ═══════════════════════════════════════════════════════════════════════════
 * `tome/class/uiset/Minimalist.lua:1532-1540` blits `player.money` onto the
 * permanent frame every pass, in gold, beside the experience track and the
 * player's name. Ours had the number only in the bag's title bar
 * (`ui/inventory.ts:645-646`), so "can I afford this" was a keypress away from
 * every screen except the one where you spend it.
 *
 * ═══ WHY IT IS ITS OWN FILE, AND THE PRECEDENT IT FOLLOWS ═══
 * `ui/xpbar.ts` exists for exactly this reason and its header argues the case:
 * a widget that shares the 18-pixel strip with the pip row still may not live
 * in `ui/resource.ts`, because that file's header is a sustained argument that
 * its row is not a bar. A purse is a third fact again — not a pool, not
 * progress — and it right-aligns into the same strip on the same reasoning.
 *
 * ═══ RIGHT-ALIGNED, AND THE CALLER OWNS THE BOX ═══
 * The strip runs: pips from the left, then this, then the experience widget at
 * the far right. This file does NOT know where the experience widget starts —
 * `main.ts` asks `xpBarGeometry` and hands the remainder down, so there is one
 * authority on that edge and not a second copy of its arithmetic. That is the
 * same rule `ui/xpbar.ts` states for importing `PIP_PX` rather than copying it.
 *
 * ═══ NULL RATHER THAN A CONFIDENT ZERO ═══
 * `money` is null until the first `inventory` frame, which is a real window on
 * connect and after every realm change (`forgetTheWorld` clears the bag). A
 * purse reading `0 GOLD` in that window is a wrong number stated confidently —
 * `ui/xpbar.ts` refuses a null `progress` for `ui/charsheet.ts:344-347`'s
 * reason, and this is the same refusal.
 */

import { PALETTE } from '../render/canvas.ts';
import { PIP_PX } from './resource.ts';
import { fitText } from './panel.ts';
import type { PanelRect } from './panel.ts';

/** Matches the strip's other text — `ui/xpbar.ts` and `ui/resource.ts` agree. */
const FONT = 'bold 10px ui-monospace, Consolas, monospace';
/** The monospace cell the strip is measured in, as `ui/xpbar.ts` measures it. */
const CHAR_W = 6;

/**
 * THE SPELLING IS THE BAG'S, DELIBERATELY.
 *
 * `ui/inventory.ts:646` already prints `  123 GOLD` in the panel title, and
 * upstream prints bare digits. One fact gets one format: a player who reads
 * `412 GOLD` on the strip and `412` in the bag has to work out that they are
 * the same number. The character sheet made the identical call for the stat
 * pair (`view/inspect.ts` — "One format for one fact wins over a per-dialog
 * match"), and this follows it.
 */
const SUFFIX = ' GOLD';

/**
 * Air between the purse and the experience widget to its right.
 *
 * EXPORTED because `main.ts` subtracts it when it works out the box, and a
 * literal at that call site would be a second copy of this widget's spacing
 * living in the file that is least likely to be read when this one changes.
 * `ui/xpbar.ts` keeps its own `GAP` private for the opposite reason: nothing
 * outside it needs to know the distance between a track and a badge.
 */
export const PURSE_GAP = 8;

export type PurseGeometry = {
  /** The text box, right-aligned inside the box the caller supplied. */
  readonly box: PanelRect;
  /** `412 GOLD`. Composed here so the painter and a test read one copy. */
  readonly label: string;
};

/**
 * Where the purse goes, or null when it should not be drawn at all.
 *
 * NULL FOR THREE REASONS, and they are all "say nothing rather than something
 * wrong": no purse has arrived yet (`money === null`), the value is not a
 * finite number a renderer can print, or the box is too narrow to hold the text
 * without running into the pips. A widget that printed itself over the resource
 * row would cost a player the number they steer a fight by, to show them one
 * they can open a bag for.
 *
 * NEGATIVE IS CLAMPED TO ZERO rather than refused. `InventoryMsg.money` is
 * documented as "a whole number, never negative", so a negative here means a
 * malformed frame — and the wire is validated on the way IN to the server, not
 * on the way out to the browser. Printing `-40 GOLD` on permanent furniture is
 * worse than printing the floor of it.
 */
export function purseGeometry(
  money: number | null,
  x: number,
  y: number,
  width: number,
): PurseGeometry | null {
  if (money === null || !Number.isFinite(money)) return null;

  const label = `${String(Math.max(0, Math.floor(money)))}${SUFFIX}`;
  const w = label.length * CHAR_W;
  if (width < w) return null;

  return { box: { x: x + width - w, y, w, h: PIP_PX }, label };
}

export type PurseOptions = {
  readonly ctx: CanvasRenderingContext2D;
  /** Null until the first `inventory` frame. NOTHING is drawn. See the header. */
  readonly money: number | null;
  /** Top-left of the pip ROW — the same `y` `drawResource` is given. */
  readonly x: number;
  readonly y: number;
  /** The room left between the pips and the experience widget. */
  readonly width: number;
};

/**
 * Paint the purse.
 *
 * `save`/`restore` around everything, because it sets `font`, `textAlign`,
 * `textBaseline` and `fillStyle` and the world painter re-sets none of them —
 * `ui/xpbar.ts` records the same trap and `ui/turncards.ts:786-790` records it
 * for `ctx.filter`.
 *
 * NO SPRITE, for `ui/xpbar.ts`'s reason: there is no coin in the manifest,
 * `test/client/assets.test.ts` pins the loader's prefix list so adding an id is
 * forbidden, and one `fillText` is the whole widget. Gold ink is what carries
 * the meaning, which is upstream's own choice — `Minimalist.lua:1535` composes
 * the string at `255, 215, 0`.
 */
export function drawPurse(options: PurseOptions): void {
  const { ctx, money, x, y, width } = options;
  const geometry = purseGeometry(money, x, y, width);
  if (geometry === null) return;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.font = FONT;
  ctx.fillStyle = PALETTE.GOLD;

  const { box, label } = geometry;
  ctx.fillText(fitText(ctx, label, box.w), box.x + box.w, box.y + PIP_PX / 2);

  ctx.restore();
}
