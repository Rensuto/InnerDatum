/**
 * THE MOMENT COMBAT STARTS. And the moment it stops.
 *
 * ===========================================================================
 * THIS IS A BUG REPORT FROM REAL PLAY, NOT A FLOURISH
 * ===========================================================================
 * From the first session on the live host: "the enemy does show up and will
 * initiate combat when too close. The problem is the players do not know when
 * combat starts and there is no indicator that it's turn-based once combat
 * starts." game-design.md § 4 already named that as the known killer of co-op
 * turn-based; it is now observed rather than theoretical.
 *
 * The cause was on the wire and is fixed there (protocol v5): `TurnMsg` now
 * carries `inCombat`, so the client is TOLD whether the fight is on instead of
 * inferring it from `whoseTurn` being non-empty — an inference that has no
 * transition in it and cannot tell "the fight just started" from "we are waiting
 * on one straggler". This file is what the client does with that flag.
 *
 * ===========================================================================
 * THREE SIGNALS, TWO OF THEM PERMANENT, ONE OF THEM LOUD
 * ===========================================================================
 * A transition that is only ever announced is a transition that is missed by
 * whoever was looking at their hotbar, and an announcement nobody notices is
 * indistinguishable from silence. So the crossing is said three ways:
 *
 *   1. THE BANNER (here). Full width, across the top of the map, ~2.5 s and
 *      then gone. This is the one moment in the game that is allowed to be
 *      loud, and it is loud on purpose.
 *   2. THE FRAME (`drawPlayfieldFrame`, here, drawn by ui/turnbar.ts). Crimson
 *      around the playfield for as long as the fight lasts. A PERSISTENT state
 *      cue: someone who looked away during the banner can still answer "are we
 *      in a fight?" from the corner of their eye, and someone who reconnected
 *      into an ongoing fight — and therefore never saw a crossing at all — gets
 *      it too.
 *   3. A RECORD LINE (`CombatAnnouncement.record`, written by main.ts). The
 *      durable copy, in the transcript people scroll back through.
 *
 * Plus a fourth in the DOM: main.ts puts the same fact into the `aria-live`
 * status line, which is where a screen reader hears it. THE INFORMATION IS NEVER
 * CARRIED BY THE ANIMATION ALONE — see `prefersReducedMotion` below.
 *
 * ===========================================================================
 * WHY THE FRAME KEEPS TWO RINGS INSTEAD OF RECOLOURING ONE
 * ===========================================================================
 * The gold frame already meant one thing — "the game is waiting on YOU" — and
 * that is the single most important thing the screen says (game-design.md § 4).
 * Simply recolouring it crimson in combat would delete the your-move signal at
 * exactly the moment it matters most, so instead the frame answers two questions
 * with two concentric rings:
 *
 *   OUTER, crimson, 3 px — is combat on? Drawn whether or not you owe a move.
 *   INNER, gold, 2 px    — is the game waiting on you? Unchanged in meaning.
 *
 * Out of combat there is no outer ring, so the border is exactly what it was.
 * In combat the border is crimson-led and up to five pixels thick, which is the
 * colour AND weight change a glance can catch. Each colour keeps exactly one
 * meaning, which is the rule the four turn chips are built on.
 *
 * ===========================================================================
 * NO ANIMATION SYSTEM. A TIMESTAMP AND ONE BOUNDED TIMER
 * ===========================================================================
 * PLAN.md § 10 lists "animation playback of any kind" under Never, and main.ts
 * runs a dirty flag rather than a permanent 60 fps loop. So this holds a
 * `shownAt` timestamp, derives its alpha from `Date.now()` at draw time, and
 * owns exactly ONE timer at a time — a hold `setTimeout`, then, only while the
 * fade is actually on screen, a ~60 ms interval that stops itself. Same shape as
 * the sweep beat in render/sweep.ts and the Bell in main.ts: a bounded loop that
 * ends when the thing it animates ends. Between banners this file costs nothing.
 */

import { TurnActorKind } from '../../shared/protocol.ts';
import { PALETTE } from '../render/canvas.ts';
import { fitText } from './panel.ts';
import type { TurnMsg } from '../../shared/protocol.ts';

/**
 * WHICH CROSSING HAPPENED. There are only two, and both matter.
 *
 * `Closed` is not an afterthought: a party that does not know the fight is over
 * holds position, keeps committing one careful turn at a time and waits for a
 * sweep that is never coming. That is the same failure as not knowing it began,
 * with a longer tail.
 */
export const CombatCue = {
  /** Free movement -> engaged. `inCombat` false -> true. */
  Opened: 'opened',
  /** Engaged -> free movement. `inCombat` true -> false. */
  Closed: 'closed',
} as const;
export type CombatCue = (typeof CombatCue)[keyof typeof CombatCue];

/**
 * The words for one crossing, decided ONCE at the instant it happened.
 *
 * All three strings are built together and kept together because they are one
 * utterance in three places — the banner, the transcript and (through main.ts)
 * the status line. Composing the Record line separately from the headline is how
 * the log and the screen end up describing the same moment differently.
 */
export type CombatAnnouncement = {
  readonly cue: CombatCue;
  /** The loud line. Bold, centred, parchment. */
  readonly headline: string;
  /** The quiet line under it, which is where the RULE CHANGE is spelled out. */
  readonly detail: string;
  /** One Record-lane line for the Case Log. */
  readonly record: string;
};

/**
 * What the hostile side is called when the frame does not say.
 *
 * The server names the aggregate card ("The Filed"), and on an OPENING crossing
 * that card is guaranteed present — the projector emits it exactly while
 * engaged, and `inCombat` is true by definition of the crossing. The fallback is
 * for the closing line and for a half-deployed server, and it names the party's
 * word for them rather than "the enemy", which is not a word this game uses.
 */
const DEFAULT_SIDE = 'the Filed';

/** The one card that stands for every hostile on the floor. See protocol.ts. */
function hostileSide(turn: TurnMsg): string {
  const card = turn.actors.find((actor) => actor.kind === TurnActorKind.Monsters);
  return card === undefined || card.name === '' ? DEFAULT_SIDE : card.name;
}

/**
 * The prose. Outer Index register: clerical, ominous, understated.
 *
 * THE DETAIL LINE IS THE HALF THAT ANSWERS THE ACTUAL COMPLAINT — "there is no
 * indicator that it's turn-based once combat starts". A player who has only ever
 * walked around freely has no reason to know the rules just changed, so the
 * banner says what changed rather than only that something did. It says the
 * party decides TOGETHER, never that anyone is waiting for their go: Inner Datum
 * is phase-locked (DECISIONS.md D1), the whole party acts in the same window,
 * and prose implying a queue would invent exactly the spinner D1 exists to
 * prevent.
 *
 * Exhaustive over `CombatCue` with no `default`, so a third crossing cannot ship
 * without words.
 */
export function combatAnnouncement(cue: CombatCue, turn: TurnMsg): CombatAnnouncement {
  switch (cue) {
    case CombatCue.Opened: {
      const side = hostileSide(turn);
      return {
        cue,
        headline: `CONTACT — ${side} have seen you`,
        detail: 'the case is open · every move costs a turn · the party decides together',
        record: `CONTACT — ${side} have seen you. Every move costs a turn until the Index closes.`,
      };
    }
    case CombatCue.Closed:
      return {
        cue,
        headline: 'THE INDEX CLOSES — nothing is hunting you',
        detail: 'the file is shut · move freely · nobody is waiting on you',
        record: 'The Index closes — nothing is hunting you. Free movement.',
      };
  }
}

// ---------------------------------------------------------------------------
// The frame around the playfield
// ---------------------------------------------------------------------------

/** Crimson, drawn for the whole duration of the fight. */
const CONTACT_FRAME_PX = 3;
/** Gold, the pre-existing "the game is waiting on you" ring. */
const TURN_FRAME_PX = 2;

/**
 * The thickest the frame can ever be, exported so the prose strips that sit
 * inside the playfield (main.ts's `drawLine`) can inset past it instead of
 * carrying a hand-tuned number that goes stale the day a ring changes weight.
 */
export const PLAYFIELD_FRAME_MAX_PX = CONTACT_FRAME_PX + TURN_FRAME_PX;

export type PlayfieldFrameOptions = {
  readonly ctx: CanvasRenderingContext2D;
  /** First row BELOW the turn bar — the frame never crosses the party strip. */
  readonly top: number;
  /** Logical backbuffer size, in world pixels — not device pixels. */
  readonly width: number;
  readonly height: number;
  /** `TurnMsg.inCombat`, straight off the wire. Never derived here. */
  readonly inCombat: boolean;
  /** `isYourTurn(view)` from ui/turnbar.ts. */
  readonly yourTurn: boolean;
};

/** Four rects, not a `strokeRect`: a stroke straddles the path and half-pixels. */
function ring(
  ctx: CanvasRenderingContext2D,
  colour: string,
  x: number,
  y: number,
  w: number,
  h: number,
  thickness: number,
): void {
  if (w <= thickness * 2 || h <= thickness * 2) return;
  ctx.fillStyle = colour;
  ctx.fillRect(x, y, w, thickness);
  ctx.fillRect(x, y + h - thickness, w, thickness);
  ctx.fillRect(x, y, thickness, h);
  ctx.fillRect(x + w - thickness, y, thickness, h);
}

/**
 * Both rings, in one place, because they are one border.
 *
 * ONE PAINTER OWNS THE WHOLE FRAME for the same reason `dockLayout` owns the
 * dock's geometry in main.ts: two functions drawing concentric rings is two
 * copies of the same inset arithmetic, and the first time they disagree the gold
 * ring is a pixel outside the crimson one and the border looks broken rather
 * than informative.
 */
export function drawPlayfieldFrame(options: PlayfieldFrameOptions): void {
  const { ctx, top, width, height, inCombat, yourTurn } = options;
  const h = height - top;
  if (h <= 0 || width <= 0) return;

  ctx.save();
  if (inCombat) ring(ctx, PALETTE.CRIMSON, 0, top, width, h, CONTACT_FRAME_PX);
  if (yourTurn) {
    // Inside the crimson when there is crimson, at the edge when there is not —
    // so out of combat the frame is byte-identical to the one M2 shipped.
    const inset = inCombat ? CONTACT_FRAME_PX : 0;
    ring(ctx, PALETTE.GOLD, inset, top + inset, width - inset * 2, h - inset * 2, TURN_FRAME_PX);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// The banner
// ---------------------------------------------------------------------------

/**
 * How long the banner sits at full strength.
 *
 * Long enough to read two lines twice — the second line is a rules change and
 * people read those slowly — and short enough that it is gone before anybody has
 * finished deciding what to do about it. The map underneath is not obscured by
 * more than one tile row while it is up.
 */
const HOLD_MS = 2500;
/** The fade. Decoration only: the frame and the log still say it afterwards. */
const FADE_MS = 600;
/**
 * How often the fade repaints. ~17 fps for 600 ms — ten draws, once per
 * crossing, and then the timer stops itself. Not a frame rate: nothing else in
 * this client redraws on a schedule.
 */
const FADE_TICK_MS = 60;

/** Two rows of 10px text plus breathing room. */
const BANNER_H = 30;
const HEADLINE_Y = 11;
const DETAIL_Y = 22;
const TEXT_PAD = 4;

const FONT_HEADLINE = 'bold 10px ui-monospace, Consolas, monospace';
const FONT_DETAIL = '10px ui-monospace, Consolas, monospace';

/**
 * Does this player want the screen to hold still?
 *
 * READ AT SHOW TIME, NOT AT MODULE LOAD, so that toggling the OS setting mid
 * session is honoured without a reload — and so a browser that reports it late
 * (the Discord webview is not a browser anybody controls) is not permanently
 * misread from one early query.
 *
 * Reduced motion removes the FADE ONLY. The banner still appears, still holds
 * for its full 2.5 s, and still says the same two sentences; it simply vanishes
 * in one draw instead of dissolving over ten. That is the whole rule this
 * setting has to satisfy — the state change must never be carried by the
 * animation — and it is also why the frame and the Record line exist.
 */
function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export type CombatBannerOptions = {
  /** Something drawable changed: the banner opened, faded a step, or ended. */
  readonly onChange: () => void;
};

export type CombatBannerDrawOptions = {
  readonly ctx: CanvasRenderingContext2D;
  /** Logical backbuffer width, in world pixels. */
  readonly width: number;
  /** First row below the turn bar — the top of the map. */
  readonly top: number;
};

export type CombatBanner = {
  /**
   * Feed every `turn` frame through this. Returns the crossing that just
   * happened, or null — which is almost always.
   */
  readonly sync: (turn: TurnMsg) => CombatAnnouncement | null;
  readonly draw: (options: CombatBannerDrawOptions) => void;
  /**
   * Forget everything, including which side of the crossing we were on. What a
   * `welcome` does: the world has been replaced, and the next `turn` frame is a
   * baseline rather than a transition.
   */
  readonly reset: () => void;
};

export function createCombatBanner(options: CombatBannerOptions): CombatBanner {
  /**
   * The last `inCombat` this client was told, or null before the first frame.
   *
   * THE NULL IS THE WHOLE POINT OF THE FIRST-FRAME RULE. A client that joins or
   * reconnects into an ongoing fight must not be told "CONTACT — they have seen
   * you" about a fight that started five minutes ago; it gets the crimson frame,
   * which is the state cue, and no announcement, because from its point of view
   * nothing crossed. Only a genuine false -> true (or true -> false) fires.
   */
  let engaged: boolean | null = null;

  /** What is on screen, or null. Also the "is a timer relevant" flag. */
  let live: CombatAnnouncement | null = null;
  let shownAt = 0;
  /** Captured when the banner opened, so one banner cannot change its mind. */
  let reduced = false;

  /** window.setTimeout/setInterval never return 0, so 0 is "not running". */
  let holdTimer = 0;
  let fadeTimer = 0;

  function stopTimers(): void {
    if (holdTimer !== 0) {
      window.clearTimeout(holdTimer);
      holdTimer = 0;
    }
    if (fadeTimer !== 0) {
      window.clearInterval(fadeTimer);
      fadeTimer = 0;
    }
  }

  function end(): void {
    stopTimers();
    if (live === null) return;
    live = null;
    options.onChange();
  }

  function startFade(): void {
    holdTimer = 0;
    fadeTimer = window.setInterval(() => {
      if (Date.now() - shownAt >= HOLD_MS + FADE_MS) {
        end();
        return;
      }
      options.onChange();
    }, FADE_TICK_MS);
  }

  function show(announcement: CombatAnnouncement): void {
    // REPLACE, NEVER QUEUE. Engagement can in principle drop and re-arm in
    // consecutive turns (it decays a few turns after the last contact rather
    // than snapping to zero), and a queued "the Index closes" playing after
    // combat has already resumed would be a banner that is simply wrong.
    stopTimers();
    live = announcement;
    shownAt = Date.now();
    reduced = prefersReducedMotion();
    holdTimer = window.setTimeout(reduced ? end : startFade, HOLD_MS);
    options.onChange();
  }

  function sync(turn: TurnMsg): CombatAnnouncement | null {
    const next = turn.inCombat;
    if (engaged === next) return null;

    const first = engaged === null;
    engaged = next;
    // The baseline frame. See `engaged` above: this is a state, not a crossing.
    if (first) return null;

    const announcement = combatAnnouncement(next ? CombatCue.Opened : CombatCue.Closed, turn);
    show(announcement);
    return announcement;
  }

  /** 1 while held, ramping to 0 across the fade. 0 means "draw nothing". */
  function alpha(now: number): number {
    if (live === null) return 0;
    const elapsed = now - shownAt;
    if (reduced || elapsed <= HOLD_MS) return 1;
    // Clamped rather than trusted: a backgrounded tab throttles timers, so a
    // draw can legitimately arrive long after the fade should have finished.
    return Math.max(0, 1 - (elapsed - HOLD_MS) / FADE_MS);
  }

  /**
   * Paint it, if there is one.
   *
   * DRAWN LAST BY main.ts, over the dock and the hotbar. For these two and a
   * half seconds this is the most important thing on the screen, and a banner
   * tucked under the party panel would be a banner that answers the bug report
   * with "well, it was there".
   *
   * Wrapped in save/restore because it sets `globalAlpha`, `font`, `textAlign`
   * and `textBaseline`; a leaked 0.4 alpha would make every later sprite in the
   * frame translucent, which reads as a broken PNG rather than as a missing
   * restore.
   */
  function draw(opts: CombatBannerDrawOptions): void {
    const announcement = live;
    if (announcement === null) return;

    const a = alpha(Date.now());
    if (a <= 0) return;

    const { ctx, width, top } = opts;
    const opened = announcement.cue === CombatCue.Opened;

    ctx.save();
    ctx.globalAlpha = a;
    ctx.imageSmoothingEnabled = false;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // CRIMSON GROUND for the opening, VOID for the closing. The close is
    // deliberately the quieter of the two: it is good news, and news that
    // shouts as loudly as an ambush teaches people to stop reading banners.
    ctx.fillStyle = opened ? PALETTE.CRIMSON : PALETTE.VOID;
    ctx.fillRect(0, top, width, BANNER_H);
    // A rule along the bottom edge in the colour the border is about to be —
    // orange leading into crimson, gold leading back to free movement — so the
    // banner and the frame are visibly the same announcement.
    ctx.fillStyle = opened ? PALETTE.ORANGE : PALETTE.GOLD;
    ctx.fillRect(0, top + BANNER_H - 1, width, 1);

    const mid = Math.floor(width / 2);
    const maxPx = width - TEXT_PAD * 2;

    ctx.font = FONT_HEADLINE;
    ctx.fillStyle = PALETTE.PARCHMENT;
    ctx.fillText(fitText(ctx, announcement.headline, maxPx), mid, top + HEADLINE_Y);

    ctx.font = FONT_DETAIL;
    ctx.fillStyle = opened ? PALETTE.GOLD : PALETTE.SILVER;
    ctx.fillText(fitText(ctx, announcement.detail, maxPx), mid, top + DETAIL_Y);

    ctx.restore();
  }

  // No `onChange` here, deliberately: the only caller is the `welcome` case in
  // main.ts, which requests a draw for the whole replaced world immediately
  // afterwards. Firing one from here would queue a second draw of a board that
  // is mid-replacement.
  function reset(): void {
    stopTimers();
    engaged = null;
    live = null;
  }

  return { sync, draw, reset };
}
