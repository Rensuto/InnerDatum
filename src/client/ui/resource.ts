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
/**
 * Pip row plus the breathing room that keeps it off the hotbar frame. The whole
 * height of the row: `partypanel.ts` sizes the self row from this.
 *
 * (There was a second, taller shape — `stacked`, which dropped D1's AP and MP
 * rows to a second line in the narrow party pane. The rows went with the
 * budget, the second line was left reserved and empty, and the shape went too.)
 */
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

/**
 * Advance of one glyph in the 10px monospace above.
 *
 * The same six pixels ui/charsheet.ts:172, ui/tooltip.ts and ui/contextmenu.ts
 * spend, and for the same reason those files give: it decides how big a BOX is
 * and nothing else. The strings themselves go through the real context at paint
 * time. Consolas advances 0.55em, so six is a deliberate over-estimate — the
 * safe direction for a box, and the wrong one for positioning one string
 * against another, which nothing here does.
 */
const CHAR_W = 6;

/**
 * JUST ENOUGH OF A POOL TO SAY HOW WIDE ITS LINE IS.
 *
 * Taking a `Pick` rather than the whole view is what lets a caller ask about a
 * pool SHAPE that no frame has sent — which is exactly what
 * `WIDEST_POOL_LINE_W` below does.
 */
export type PoolShape = Pick<ResourceView, 'kind' | 'current' | 'max' | 'discrete'>;

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
export function pipCount(resource: PoolShape): { total: number; filled: number } {
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
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS ROW PRINTS BESIDE THE PIPS. One producer, two readers.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `drawResource` built this string TWICE — once for a stacked shape it no
 * longer has and once for the flat one — with the `bare` test spelled out in
 * both. The reader that made it worth extracting is the other one:
 * `poolLineW` has to measure the string the painter will actually draw, not a
 * string that looks like it.
 *
 * NO FIGURE BESIDE A DISCRETE POOL THE ROW COULD DRAW. "3/8" next to eight
 * countable vials says the same thing twice and re-frames the pips as
 * decoration on a fraction, which is the bar this whole file exists to avoid.
 * A pool the row could NOT draw (`total === 0`, the `MAX_PIPS` valve) falls
 * back to the figure rather than to nothing at all.
 */
export function poolText(pool: PoolShape): string {
  const { total } = pipCount(pool);
  const bare = pool.discrete && total > 0;
  return bare
    ? resourceLabel(pool.kind)
    : `${resourceLabel(pool.kind)} ${Math.floor(pool.current)}/${Math.floor(pool.max)}`;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW WIDE THE POOL LINE WANTS TO BE: every pip, the gap, and `poolText`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE ARITHMETIC IS `drawResource`'s OWN, not a second estimate of it. The pip
 * loop advances `PIP_PX + PIP_GAP` per pip, the painter then adds `PIP_GAP * 2`
 * before the text, and the text is drawn from there. Any other answer here
 * would be a box sized against a row nobody draws.
 *
 * IT IS A WANT, NOT A REQUIREMENT. The row already survives a narrower box:
 * pips stop when the next one would not fit and the figure is skipped once the
 * cursor is past the edge. What it does NOT survive is a box that is wide
 * enough to start the text and too narrow to finish it — the text is drawn on
 * the `cursor < x + width` test and then CLIPPED by the pane, which is the
 * reported bug (`PARTY_PANE_W`).
 */
export function poolLineW(pool: PoolShape): number {
  const { total } = pipCount(pool);
  return total * (PIP_PX + PIP_GAP) + PIP_GAP * 2 + poolText(pool).length * CHAR_W;
}

/**
 * The widest figure a pool prints. Every authored pool is 0-100 or 0-8, so
 * three digits either side is the widest `cur/max` the row can carry, and 100
 * is the shortest number that is three digits wide.
 */
const WIDEST_POOL_FIGURE = 100;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WIDEST POOL LINE ANY CLASS CAN PUT ON A ROW. The party pane's width.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WALKED OVER `ResourceKind` ITSELF rather than over a list somebody typed: the
 * union is the closed set the wire carries, so a fifth kind is included here
 * the moment it is named, and there is no second table to forget to update. The
 * same device `SLOT_ORDER` uses, and the opposite of a hand-typed list that
 * claims to be `Object.values(...)`.
 *
 * ═══ AT THE CONTINUOUS SHAPE, WHICH IS THE WIDER ONE FOR EVERY AUTHORED POOL ═══
 * A continuous pool is `CONTINUOUS_PIPS` pips AND the figure; a discrete one is
 * `max` pips and the bare label. At the maxima the game actually authors —
 * 0-100 for Resolve, Focus and Ink, a discrete 0-8 for Reagents — the
 * continuous shape is the wider of the two for every kind, so measuring every
 * kind as continuous is an upper bound on all four rather than a guess about
 * which one wins.
 *
 * ═══ IT IS AN UPPER BOUND ON THE AUTHORED POOLS AND NOT ON EVERY POSSIBLE ONE ═══
 * `MAX_PIPS` is 16, so a discrete pool of sixteen would want 224 pixels of pips
 * before a single letter is drawn and would exceed this. That is stated rather
 * than defended: no class carries one, and `partypanel.test.ts` walks the REAL
 * class table — every class, its real kind, its real maximum — and fails the
 * day one does. A constant derived from a shape needs a test against the world,
 * and that is the test.
 */
export const WIDEST_POOL_LINE_W = Math.max(
  ...Object.values(ResourceKind).map((kind) =>
    poolLineW({
      kind,
      current: WIDEST_POOL_FIGURE,
      max: WIDEST_POOL_FIGURE,
      discrete: false,
    }),
  ),
);

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

  // NO AP OR MP ROWS. They were the open round's fuel gauge — "an empty row
  // means the turn is about to end" — and there is no open round now: every
  // action ends the turn (`actPlayer`), and the budget itself is retired. ToME
  // has no such budget; this HUD shows none.

  cursor += PIP_GAP * 2;
  ctx.fillStyle = PALETTE.BONE;
  // The figure is printed unless the pips ARE the figure — `poolText` owns that
  // rule, and owning it once is what lets `poolLineW` measure the string that
  // is actually drawn.
  if (cursor < x + width) ctx.fillText(poolText(resource), cursor, midY);

  ctx.restore();
}
