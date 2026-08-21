/**
 * The class resource, as DISCRETE PIPS. Never a bar.
 *
 * ===========================================================================
 * THE ARGUMENT IS COUNTABILITY, NOT STASIS
 * ===========================================================================
 * game-design.md § 2 on the Alchemist: "Reagents are a countable stock of 0-8
 * that refills on kills, at stairs, and one whole vial every twelve turns — not
 * a regenerating bar. Every cast is a discrete decision."
 *
 * This header used to quote the older half of that sentence and lean on "not a
 * regenerating bar" as though the mechanic were the pool standing still. It is
 * not, and the distinction matters now that the pool trickles: THE MECHANIC IS
 * THAT THE UNITS ARE COUNTABLE OBJECTS. A bar answers "how full am I?"; pips
 * answer "how many casts do I have left?", and the second question is the only
 * one the Alchemist's player is ever asking — a question that a pool refilling
 * one WHOLE vial at a time still answers exactly. Three-of-eight drawn as a bar
 * reads as 37% of something continuous; drawn as three filled shapes beside five
 * empty ones it reads as three vials, which is what it is whether or not a
 * fourth is coming.
 *
 * The server is what makes that safe rather than aspirational: a discrete pool's
 * remainder lives on an integer turn counter beside the pool, so `current` is
 * always a whole number by the time it reaches this file. Nothing here needs to
 * defend against a fraction, and nothing here should start drawing a partial pip
 * to "show progress" — that is the bar, reintroduced one sixteenth at a time.
 *
 * `ResourceView.discrete` carries the distinction on the wire rather than being
 * a table in this file, because which pools are countable is authored data — and
 * a client-side copy of that table is precisely the one that will be missing the
 * Enforcer's Shells in M5.
 *
 * ===========================================================================
 * SHAPE FIRST, COLOUR SECOND — THE SAME RULE AS THE TURN CHIPS
 * ===========================================================================
 * `ui_pip_resolve`, `ui_pip_focus` and `ui_pip_reagent_full` are three distinct
 * 12x12 silhouettes, drawn that way deliberately. A player glances at this for a
 * third of a second, roughly one man in twelve cannot separate the red pip from
 * the green one, and the Discord overlay is not colour-managed.
 *
 * The same rule decides the EMPTY pip. Only Reagents were drawn with an empty
 * variant (`ui_pip_reagent_empty`), so Resolve and Focus get a hollow outline
 * traced by hand below. Hollow-versus-solid is a shape difference, which is what
 * this file needs; drawing the full pip at 30% alpha would have been one line
 * shorter and would have signalled the state with nothing but brightness.
 */

import { ResourceKind } from '../../shared/protocol.ts';
import { PALETTE } from '../render/canvas.ts';
import type { ResourceView } from '../../shared/protocol.ts';
import type { SpriteSource } from '../render/assets.ts';

/** The authored pip size. Every pip PNG in the manifest is 12x12. */
export const PIP_PX = 12;
const PIP_GAP = 2;
/** Pip row plus the breathing room that keeps it off the hotbar frame. */
export const RESOURCE_H = PIP_PX + 6;

/**
 * How many pips a CONTINUOUS pool is drawn as.
 *
 * Resolve and Focus run 0-100, and a hundred pips is not a readable row — so a
 * continuous pool is quantised to ten notches, each worth ten points, and the
 * exact number is printed beside them. Ten because it is the coarsest scale on
 * which "I am one notch from Iron Curtain" is still a true and useful sentence.
 *
 * A DISCRETE pool is never quantised: 0-8 Reagents is eight pips, one per cast,
 * and that is the whole point of `discrete`.
 */
const CONTINUOUS_PIPS = 10;

/** Beyond this many pips the row is drawn as a number instead. See `pipCount`. */
const MAX_PIPS = 16;

const FONT = 'bold 10px ui-monospace, Consolas, monospace';

export type ResourceOptions = {
  readonly ctx: CanvasRenderingContext2D;
  readonly sprites: SpriteSource;
  /** Null until the first `resource` frame; nothing is drawn. */
  readonly resource: ResourceView | null;
  /** Top-left of the row, in LOGICAL backbuffer pixels. */
  readonly x: number;
  readonly y: number;
  /** How much width the row may use. The row is left-aligned inside it. */
  readonly width: number;
};

/**
 * Pip art ids for a resource kind.
 *
 * An exhaustive switch with no `default`: when the Enforcer's Shells join
 * `ResourceKind` this stops compiling and names itself, rather than quietly
 * drawing Shells as Reagents. `empty: null` means "no empty art was drawn for
 * this kind" and the hollow fallback runs.
 */
function pipArt(kind: ResourceKind): { readonly full: string; readonly empty: string | null } {
  switch (kind) {
    case ResourceKind.Resolve:
      return { full: 'ui_pip_resolve', empty: null };
    case ResourceKind.Focus:
      return { full: 'ui_pip_focus', empty: null };
    case ResourceKind.Reagents:
      return { full: 'ui_pip_reagent_full', empty: 'ui_pip_reagent_empty' };
    // CONTINUOUS, like Resolve and Focus -- there is no countable unit of ink,
    // so there is no empty-pip art to draw and the hollow fallback is right.
    case ResourceKind.Ink:
      return { full: 'ui_pip_ink', empty: null };
  }
}

/** Human label, for the row and for the status line. */
export function resourceLabel(kind: ResourceKind): string {
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

/**
 * How many pips this pool is drawn as, and how many of them are filled.
 *
 * `Math.floor` on the filled count and not `round`, deliberately: a pip must
 * never be lit for a cast you cannot make. Rounding up at 9 Resolve would light
 * the first notch of a 10-point pip and tell the Watchman he can afford
 * something he cannot.
 *
 * The `MAX_PIPS` guard is a safety valve, not a feature — a content edit that
 * sets a discrete pool to 40 would otherwise draw 40 pips off the side of the
 * viewport. Above the cap the row collapses to the number alone, which is ugly
 * and honest.
 */
export function pipCount(resource: ResourceView): { total: number; filled: number } {
  const max = Math.max(0, Math.floor(resource.max));
  const current = Math.min(Math.max(0, resource.current), max);

  if (resource.discrete) {
    if (max > MAX_PIPS) return { total: 0, filled: 0 };
    return { total: max, filled: Math.floor(current) };
  }

  if (max <= 0) return { total: 0, filled: 0 };
  const perPip = max / CONTINUOUS_PIPS;
  return { total: CONTINUOUS_PIPS, filled: Math.floor(current / perPip) };
}

/**
 * One pip. Art when there is art, a traced shape when there is not.
 *
 * The hollow fallback is a 12x12 outline: a genuinely different silhouette from
 * a filled pip, legible at a glance and in greyscale. The loud violet box the
 * renderer uses for a missing sprite is deliberately NOT reused here — a missing
 * *empty* pip is the expected case for two of the three kinds, not a pipeline
 * regression, and shouting about it every frame would train everyone to ignore
 * the shout.
 */
function drawPip(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  id: string | null,
  x: number,
  y: number,
  filled: boolean,
): void {
  const sprite = id === null ? undefined : sprites.sprite(id);
  if (sprite !== undefined) {
    ctx.drawImage(sprite.image, x, y, sprite.w, sprite.h);
    return;
  }

  if (filled) {
    ctx.fillStyle = PALETTE.GOLD;
    ctx.fillRect(x + 1, y + 1, PIP_PX - 2, PIP_PX - 2);
    return;
  }
  ctx.fillStyle = PALETTE.GREY;
  ctx.fillRect(x + 1, y + 1, PIP_PX - 2, 1);
  ctx.fillRect(x + 1, y + PIP_PX - 2, PIP_PX - 2, 1);
  ctx.fillRect(x + 1, y + 1, 1, PIP_PX - 2);
  ctx.fillRect(x + PIP_PX - 2, y + 1, 1, PIP_PX - 2);
}

/**
 * Paint the row: pips, then a label, then — only for a continuous pool — the
 * exact figure.
 *
 * No number beside a discrete pool, on purpose. Eight countable vials with "3/8"
 * printed next to them says the same thing twice and quietly re-frames the pips
 * as a decoration on a fraction, which is the bar this whole file exists to
 * avoid. The pips ARE the number.
 */
export function drawResource(options: ResourceOptions): void {
  const { ctx, sprites, resource, x, y, width } = options;
  if (resource === null) return;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = FONT;

  const { total, filled } = pipCount(resource);
  const art = pipArt(resource.kind);
  const midY = y + PIP_PX / 2;

  let cursor = x;
  for (let i = 0; i < total; i += 1) {
    if (cursor + PIP_PX > x + width) break;
    const isFull = i < filled;
    drawPip(ctx, sprites, isFull ? art.full : art.empty, cursor, y, isFull);
    cursor += PIP_PX + PIP_GAP;
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE ACTING BUDGET, ON THE SAME ROW, AFTER A GAP.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * AP is what the twelve talents are priced in — Ward Rush 2, Iron Curtain 5,
   * out of 6 — and until `ResourceView.ap` landed no frame carried it, so the
   * hotbar printed a cost against a number the player could not see.
   *
   * ═══ SMALLER, DIMMER, AND SECOND ═══
   * The class resource is the thing a player builds a plan around across a
   * whole fight; AP is spent and refilled every single turn. Drawing them at
   * equal weight would make the round's small change compete with the fight's
   * big one. So these are half-height ticks in the muted ink, set after the
   * resource label — present, countable, and never the first thing the eye
   * lands on.
   *
   * ═══ TICKS AND NOT PIPS, ON PURPOSE ═══
   * `drawPip` reaches for authored 12px art keyed by `ResourceKind`, and there
   * is no AP art in the manifest — inventing a key here would draw the pink
   * missing-asset square on every frame. A tick is a rectangle, needs no
   * manifest entry, and reads correctly at six across.
   *
   * ABSENT MEANS AN OLDER SERVER, not a budget of zero: the field is optional
   * so that adding it forced no version bump, so a client can outlive a server
   * that never sends it. Drawing nothing is the honest answer.
   */
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * AND THE ROUND, WHICH IS NOT SMALL CHANGE ANY MORE.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * THE PARAGRAPH ABOVE ARGUED FOR "SMALLER, DIMMER, AND SECOND" and it was
   * right when it was written: one submitted action ended your turn, so AP was
   * priced into the talents and spent nowhere the player could feel it.
   *
   * IT IS LOAD-BEARING NOW. The round stays open while anything is still
   * affordable (`hasAffordableAction`), so these two numbers ARE the answer to
   * *"can I do something else, or am I done?"* — the question a player asked in
   * exactly those words. Half-height ticks in muted ink are the right weight for
   * a detail and the wrong weight for the thing the turn ends on.
   *
   * SO: FULL-HEIGHT BLOCKS, LIT WHEN SPENDABLE, and both budgets. `drawPip`
   * still cannot be used — it reaches for authored 12px art keyed by
   * `ResourceKind` and there is no AP art in the manifest, so a key invented
   * here would draw the pink missing-asset square on every frame. A rectangle
   * needs no manifest entry.
   *
   * ═══ FILLED MEANS LEFT, NOT SPENT ═══
   * The old loop lit `i < spent` where `spent` held `resource.ap` — the amount
   * REMAINING — so the name said one thing and the arithmetic another. It drew
   * correctly by accident. It reads as a fuel gauge now, which is what it is:
   * blocks go out as the round is used up, and an empty row means the turn is
   * about to end whether or not you press anything.
   *
   * ABSENT MEANS AN OLDER SERVER, not a budget of zero — the fields are optional
   * so adding them forced no version bump, and a client can outlive a server
   * that never sends them. Drawing nothing is the honest answer.
   */
  const budgetRow = (
    label: string,
    left: number | undefined,
    max: number | undefined,
    lit: string,
  ): void => {
    if (left === undefined || max === undefined || max <= 0) return;
    cursor += PIP_GAP * 2;
    ctx.fillStyle = PALETTE.GREY_HI;
    if (cursor < x + width) ctx.fillText(label, cursor, y + PIP_PX / 2);
    cursor += 15;
    const blockW = 4;
    const blockH = PIP_PX - 2;
    const blockY = y + 1;
    const remaining = Math.max(0, Math.min(max, Math.floor(left)));
    for (let i = 0; i < max; i += 1) {
      if (cursor + blockW > x + width) break;
      ctx.fillStyle = i < remaining ? lit : 'rgba(255,255,255,0.14)';
      ctx.fillRect(cursor, blockY, blockW, blockH);
      cursor += blockW + 2;
    }
  };

  // AP FIRST AND MP SECOND, in the order the talents are priced and the order
  // the banner says them, so a player checking one against the other never has
  // to re-read which row is which.
  budgetRow('AP', resource.ap, resource.maxAp, PALETTE.GOLD);
  budgetRow('MP', resource.mp, resource.maxMp, PALETTE.SILVER);

  cursor += PIP_GAP * 2;
  ctx.fillStyle = PALETTE.BONE;
  // The figure is printed unless the pips ARE the figure. A discrete pool with a
  // drawn row says everything already, and "3/8" beside eight countable vials
  // re-frames the pips as decoration on a fraction — the exact reading this file
  // exists to prevent. A pool the row could not draw (`total === 0`, the
  // `MAX_PIPS` valve) falls back to the number rather than to nothing at all.
  const bare = resource.discrete && total > 0;
  const label = bare
    ? resourceLabel(resource.kind)
    : `${resourceLabel(resource.kind)} ${Math.floor(resource.current)}/${Math.floor(resource.max)}`;
  if (cursor < x + width) ctx.fillText(label, cursor, midY);

  ctx.restore();
}
