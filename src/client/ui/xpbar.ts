/**
 * THE LEVEL BADGE AND THE EXPERIENCE TRACK: the two numbers a player should
 * never have to open a panel to see.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS ITS OWN FILE AND NOT A FUNCTION IN ui/resource.ts
 * ═══════════════════════════════════════════════════════════════════════════
 * It draws into the SAME 18-pixel strip the class resource does, at the far end
 * of it, and it still may not live in that file. ui/resource.ts's header is a
 * sustained argument that its row is NOT a bar — "pips answer how many casts do
 * I have left", "nothing here should start drawing a partial pip to show
 * progress — that is the bar, reintroduced one sixteenth at a time" — and an
 * experience BAR authored inside the file that says "never a bar" is a comment
 * that will mislead somebody within a month. It is also the wrong neighbour in
 * a second way that is about the player rather than about the source: the
 * Reagent pips now refill over time, so a full-width continuous gauge sitting
 * beside them is the single fastest way to teach somebody to read the pips as a
 * bar too.
 *
 * So the widget is deliberately the OPPOSITE of the pip row on all three axes
 * the eye uses to group things:
 *
 *   POSITION   the pips are left-aligned (ui/resource.ts's `drawResource` walks
 *              a cursor from `x`); this is right-aligned, at the end of the
 *              strip that is empty at every viewport.
 *   HEIGHT     `XP_TRACK_H` is 3 against the pips' 12 — one quarter.
 *   FORM       a continuous track with a filled portion, against a row of
 *              discrete countable shapes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `Lv N`, WITH NO DENOMINATOR. THAT IS ToME'S OWN HUD AND IT SIDESTEPS A
 * DOCUMENTED CONTRADICTION IN THIS CODEBASE
 * ═══════════════════════════════════════════════════════════════════════════
 * uiset/Minimalist.lua:1552-1560 caches and blits the string `"Lvl "..
 * player.level` — the level alone, no "of 50", nowhere on the frame. The gauge
 * beside it (:1518-1531) is the same shape as this one: a proportion blitted at
 * a partial width (`pf_exp[1]:toScreenPrecise(..., pf_exp[6] * p, ...)` at
 * :1520, with `p = math.min(1, math.max(0, cur_exp / max_exp))` at :1519) and a
 * readout drawn over it at :1524-1531.
 *
 * The no-denominator half is not merely a port, it is the thing that lets this
 * widget exist at all. src/shared/progression.ts:11-35 argues that the module is
 * client-safe precisely so "the panel has to draw the denominator" can be
 * answered in the browser; shared/protocol.ts:3301-3305 argues the opposite
 * about the LEVEL cap — that a client deciding for itself whether it is at the
 * ceiling "would need `MAX_CHARACTER_LEVEL`, a second copy of an authored number
 * in the browser". Drawing `Lv 3` rather than `Lv 3/10` needs neither answer.
 *
 * ═══ THE PER-LEVEL DENOMINATOR IS DRAWN, THE LEVEL DENOMINATOR IS NOT ═══
 * `ProgressMsg.xp` is XP INTO THIS LEVEL and not a running total — `gainExp`
 * subtracts the threshold on the way past (progression.ts's port of
 * ActorLevel.lua:104) — so it is already the track's numerator with no
 * arithmetic at all. `xpToNext` is the denominator and it travels on the wire
 * rather than being recomputed here, for the reason protocol.ts gives.
 *
 * OUR DEVIATION FROM ToME's `%d%%` READOUT (Minimalist.lua:1525 — :1524 is the
 * `vc = p` cache key one line above it, which is a value and not a display) is the one
 * ui/charsheet.ts:436-441 already argues in full and is not re-argued here: a
 * percentage of a threshold nobody can see answers "how far along" and not "how
 * much more". This widget prints NEITHER — no percentage, no fraction — because
 * it is two pixels of permanent furniture and the sheet is where a player goes
 * for the numbers. The track carries the proportion as a LENGTH; the badge
 * carries the level as a WORD.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO STATES THAT ARE NOT EDGE CASES
 * ═══════════════════════════════════════════════════════════════════════════
 * NULL PROGRESS DRAWS NOTHING AT ALL. `progress` arrives in the `hello` block,
 * so there is a real window on connect where it has not landed — ui/charsheet.ts
 * :344-347 makes the same point about the same frame and refuses to print
 * "Level: 0" in it, because "a row reading Level: 0 in that window would be a
 * wrong number stated confidently". Permanent furniture is WORSE there than a
 * panel is, because that window is exactly when the player is staring at the
 * screen waiting for something to appear.
 *
 * `xpToNext === 0` IS A SENTINEL AND IS NEVER A DENOMINATOR. The server's
 * `sendProgress` documents it, gateway.ts asserts it and ui/charsheet.ts:428-441
 * handles it: at `MAX_CHARACTER_LEVEL` there is no next level and `xp` keeps
 * climbing, so any division at all would be a fraction creeping towards a level
 * that never arrives — or an outright divide-by-zero drawn as a `NaN`-wide
 * rect. The cap draws a FULL, STATIC track and the word `TOP`, which is a state
 * rather than a measurement.
 *
 * It draws into the BACKBUFFER at logical scale like every other ui/ module —
 * see the long note at the top of render/canvas.ts.
 */

import { PALETTE } from '../render/canvas.ts';
import { PIP_PX } from './resource.ts';
import { fitText } from './panel.ts';
import type { ProgressMsg } from '../../shared/protocol.ts';
import type { PanelRect } from './panel.ts';

// ---------------------------------------------------------------------------
// Geometry constants. See the header before changing any of them.
// ---------------------------------------------------------------------------

/**
 * The track's height, and the number the header's whole argument rests on.
 *
 * THREE PIXELS AGAINST THE PIP ROW'S TWELVE. It is exported so a test can pin
 * that it is not `RESOURCE_H` and never becomes it: a gauge as tall as the pips
 * is a second pip row made of one long pip, which is precisely the reading
 * ui/resource.ts spends its header preventing.
 */
export const XP_TRACK_H = 3;

/**
 * The track's length. Long enough that one kill at the slowest point on the
 * curve moves it by a visible pixel, short enough that it is plainly a marker
 * rather than a gauge across the screen.
 *
 * The arithmetic: the worst case in the whole game is level 9→10, which
 * progression.ts:259-262 records as 24.4 kills, so one kill is 1/25th of the
 * track — two pixels at 48. At the other end (level 1→2, 8.4 kills) a kill is
 * nearly six pixels.
 */
const TRACK_W = 48;

/** Air between the track and the badge, and between the caption and the track. */
const GAP = 4;

/**
 * Advance of one glyph in the 10px monospace this file draws with. The same six
 * pixels ui/charsheet.ts:160-165 and ui/escapemenu.ts:181-187 use, and for the
 * same reason: it decides how big a BOX is and nothing else. The strings
 * themselves still go through `fitText` at paint time.
 */
const CHAR_W = 6;

/**
 * The widest badge this game can produce, in characters: `Lv 10` at
 * `MAX_CHARACTER_LEVEL`.
 *
 * A CHARACTER COUNT, NOT AN IMPORT OF THE CAP. Sizing a box for five glyphs is
 * not the same act as knowing where the ceiling is — protocol.ts:3301-3305's
 * objection is to the browser DECIDING it has reached the cap, and nothing here
 * decides anything: a level of 200 would simply be measured by `fitText` and
 * trimmed, exactly as every other string in this client is.
 */
const BADGE_CHARS = 5;
const BADGE_W = BADGE_CHARS * CHAR_W;

/** The word that replaces a measurement at the cap. See the header. */
const CAP_WORD = 'TOP';
const CAP_W = CAP_WORD.length * CHAR_W;

const FONT = 'bold 10px ui-monospace, Consolas, monospace';

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Where the two — or three — pieces go, and how much of the track is filled.
 *
 * PURE, AND IT TAKES NO CONTEXT, for the reason ui/contextmenu.ts:24-34 gives
 * for every geometry helper here. Nothing hit-tests this widget today (it is
 * furniture, not a control) but the same rule applies to a test, which must be
 * able to ask where the left edge landed without painting anything.
 */
export type XpBarGeometry = {
  /** The `Lv N` text box, at the extreme right of the strip. */
  readonly badge: PanelRect;
  /** The track's trough. `XP_TRACK_H` tall, always. */
  readonly track: PanelRect;
  /**
   * How many pixels of the track are lit, `0..track.w`. ALWAYS AN INTEGER: the
   * wire's `xp` is routinely fractional (`worthExp` pays 3.2 for a normal husk
   * at level 1, progression.ts:313-315), and a fractional `fillRect` width is
   * how a 1-pixel-tall row picks up an antialiased edge on a renderer that has
   * `imageSmoothingEnabled = false` everywhere precisely to avoid one.
   */
  readonly filled: number;
  /** True at `MAX_CHARACTER_LEVEL`, detected from the `xpToNext === 0` sentinel. */
  readonly atCap: boolean;
  /** The `TOP` caption's box, or null below the cap. */
  readonly caption: PanelRect | null;
  /** `Lv 3`. Composed here so the painter and a test read one copy. */
  readonly label: string;
};

/**
 * The proportion of this level that is done, clamped to `0..1`.
 *
 * ═══ THE DIVISION IS INSIDE THE GUARD AND MUST STAY THERE ═══
 * `xpToNext <= 0` returns before the division rather than after it. That is not
 * defensive style, it is the sentinel: the cap sends 0 and a division would be
 * `Infinity` or `NaN`, and `NaN` handed to `fillRect` draws nothing while
 * reporting no error at all — a widget that silently disappears at level 10 for
 * the one player who got there.
 *
 * `Number.isFinite` covers the same hole from the other side, for a frame that
 * arrived malformed: the wire is validated on the way IN to the server, not on
 * the way out to the browser.
 */
function fraction(progress: ProgressMsg): number {
  const total = progress.xpToNext;
  if (!Number.isFinite(total) || total <= 0) return 1;
  const xp = Number.isFinite(progress.xp) ? progress.xp : 0;
  // Minimalist.lua:1519 is `math.min(1, math.max(0, cur_exp / max_exp))`, and
  // the clamp is upstream's own. `xp` can legitimately exceed the threshold for
  // the instant between a kill and the base-clock pass that levels the actor.
  return Math.min(1, Math.max(0, xp / total));
}

/**
 * WHERE THE WIDGET GOES, or null when the strip cannot hold one.
 *
 * RIGHT-ALIGNED INSIDE `[x, x + width)`, which is the whole placement decision:
 * the pip row is left-aligned and is at most ten pips plus a label, so the right
 * end of this strip is empty at every viewport this game supports (the narrowest
 * backbuffer is 640 logical pixels — render/canvas.ts's `DEFAULT_VIEWPORT`).
 *
 * NULL RATHER THAN AN OVERLAP when the strip is too narrow. A widget that
 * printed itself on top of the pips would make the resource unreadable to save
 * a level number the character sheet already carries, and "draw nothing" is the
 * same answer ui/resource.ts gives when its own row runs out of width.
 *
 * `y` IS THE TOP OF THE PIP ROW — the same `y` main.ts hands `drawResource` —
 * and the track centres itself on that row. `PIP_PX` is imported rather than
 * copied for exactly the reason this file exists as a separate module and not as
 * a separate copy of the strip's arithmetic: there is one authority on how tall
 * that row is, and it is ui/resource.ts.
 */
export function xpBarGeometry(
  progress: ProgressMsg | null,
  x: number,
  y: number,
  width: number,
): XpBarGeometry | null {
  if (progress === null) return null;

  const atCap = !Number.isFinite(progress.xpToNext) || progress.xpToNext <= 0;
  const capW = atCap ? CAP_W + GAP : 0;
  const total = capW + TRACK_W + GAP + BADGE_W;
  if (width < total) return null;

  const right = x + width;
  const badge: PanelRect = { x: right - BADGE_W, y, w: BADGE_W, h: PIP_PX };
  const track: PanelRect = {
    x: badge.x - GAP - TRACK_W,
    // Centred on the pip row rather than on the 18-pixel strip: the pips are
    // what the eye lines this up against, and `RESOURCE_H`'s extra six pixels
    // are the breathing room under them (ui/resource.ts:56-57).
    y: y + Math.floor((PIP_PX - XP_TRACK_H) / 2),
    w: TRACK_W,
    h: XP_TRACK_H,
  };
  const caption: PanelRect | null = atCap
    ? { x: track.x - GAP - CAP_W, y, w: CAP_W, h: PIP_PX }
    : null;

  return {
    badge,
    track,
    // AT THE CAP THE TRACK IS FULL AND STATIC, computed WITHOUT a division —
    // `fraction` returns 1 from inside its guard, so the multiply below never
    // sees the sentinel.
    filled: Math.floor(TRACK_W * fraction(progress)),
    atCap,
    caption,
    label: `Lv ${String(Math.max(0, Math.floor(progress.level)))}`,
  };
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

export type XpBarOptions = {
  readonly ctx: CanvasRenderingContext2D;
  /** Null until the first `progress` frame. NOTHING is drawn. See the header. */
  readonly progress: ProgressMsg | null;
  /** Top-left of the pip ROW, in LOGICAL backbuffer pixels — `drawResource`'s `y`. */
  readonly x: number;
  readonly y: number;
  /** How much width the strip may use. The widget is right-aligned inside it. */
  readonly width: number;
};

/**
 * Paint the badge and the track.
 *
 * `save`/`restore` around everything because it sets `font`, `textAlign`,
 * `textBaseline` and `fillStyle`, none of which the world painter re-sets before
 * every call — a leak surfaces three milestones later as a mysteriously
 * right-aligned label somewhere else entirely (ui/turncards.ts:786-790 records
 * the identical trap for `ctx.filter`).
 *
 * NO SPRITE. There is no gauge, no frame and no keycap in the manifest, adding
 * an id is forbidden (test/client/assets.test.ts pins the loader's prefix list),
 * and two `fillRect`s plus two `fillText`s is the whole widget — the same
 * discipline ui/escapemenu.ts keeps for a much bigger surface.
 */
export function drawXpBar(options: XpBarOptions): void {
  const { ctx, progress, x, y, width } = options;
  const geometry = xpBarGeometry(progress, x, y, width);
  if (geometry === null) return;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.textBaseline = 'middle';
  ctx.font = FONT;

  const { track, badge, caption } = geometry;

  // THE TROUGH FIRST, so the unfilled remainder is a visible shape rather than
  // an absence. A lit segment floating on the panel background would read as a
  // dash of dirt at three pixels tall.
  ctx.fillStyle = PALETTE.SLATE;
  ctx.fillRect(track.x, track.y, track.w, track.h);
  if (geometry.filled > 0) {
    ctx.fillStyle = PALETTE.GOLD;
    ctx.fillRect(track.x, track.y, geometry.filled, track.h);
  }

  // THE BADGE, right-aligned against the very end of the strip so it does not
  // move as the level goes from one digit to two.
  ctx.textAlign = 'right';
  ctx.fillStyle = PALETTE.PARCHMENT;
  ctx.fillText(fitText(ctx, geometry.label, badge.w), badge.x + badge.w, badge.y + PIP_PX / 2);

  // THE CAP CAPTION — a WORD where a measurement would be, per the header, and
  // gold so it reads as an achieved state rather than as a warning.
  if (caption !== null) {
    ctx.fillStyle = PALETTE.GOLD;
    ctx.fillText(fitText(ctx, CAP_WORD, caption.w), caption.x + caption.w, caption.y + PIP_PX / 2);
  }

  ctx.restore();
}
