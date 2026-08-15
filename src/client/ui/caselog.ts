/**
 * THE CASE LOG. Two lanes, and the separation between them is the whole design.
 *
 * ===========================================================================
 * WHY TWO LANES AND NOT ONE LIST WITH TWO COLOURS
 * ===========================================================================
 * game-design.md § 11 writes the log as **Record** (terse, mechanical, cream)
 * and **Margin** (italic, violet — the Index's voice, and the players' own).
 * They are not two styles of the same stream. They are two different kinds of
 * utterance arriving at wildly different rates:
 *
 *   RECORD — what the rules did. One Alchemic Vial produces five lines; a sweep
 *     of eight monsters produces twenty. It is machine-generated, and in a fight
 *     it is a firehose.
 *   MARGIN — what a PERSON said, and where a person pointed. Perhaps three lines
 *     a minute, and every one of them is the reason four people are in a voice
 *     channel playing this instead of playing it alone.
 *
 * Interleave them and the Record buries the Margin inside one turn of combat.
 * Not "makes it harder to find" — buries it: twenty lines of arithmetic scroll
 * past between "get to me" and anyone reading it. The moment that happens the
 * log stops being a place people talk and becomes a debug console, and the
 * social half of the MVP is gone with it.
 *
 * So the Margin gets a RESERVED BAND at the bottom of the panel that the Record
 * cannot spend, plus its own scroll position. The Record can be as loud as it
 * likes and the last three things anybody said are still on screen. That
 * reservation is the feature; everything else here is presentation.
 *
 * ===========================================================================
 * IT IS A MUD. THE LOG IS A SURFACE, NOT A CONSOLE
 * ===========================================================================
 * Which is why it is drawn on the `ui_panel_9slice_inset` skin rather than as
 * bare text over the map, why it wraps on word boundaries instead of truncating
 * (the half of a Record line that gets cut is the half with the numbers in it),
 * why it carries turn separators, and why it is scrollable at all. People will
 * read this more than they read the map.
 *
 * ===========================================================================
 * SCROLLING IS BY ENTRY, NOT BY WRAPPED ROW
 * ===========================================================================
 * A wrapped row count depends on the panel width and the font, so it is only
 * knowable at draw time — keeping a scroll offset in rows would mean either
 * re-wrapping the entire history on every resize or storing a cache that goes
 * stale silently. The offset is therefore an index BACK FROM THE NEWEST ENTRY,
 * and the drawer wraps only the handful of entries it needs to fill the band.
 * Cost per frame is bounded by the band's height, not by the log's length.
 *
 * WHILE SCROLLED UP, THE VIEW DOES NOT MOVE. New lines increment the offset so
 * the reader stays on the line they were reading, and the lane says so in words
 * — a log that silently stops being live is a log that quietly lies.
 */

import { LogLane } from '../../shared/protocol.ts';
import { PALETTE } from '../render/canvas.ts';
import {
  drawHeader,
  drawPanel,
  fitText,
  PANEL_PAD,
  panelInner,
  PanelSkin,
  wrapText,
} from './panel.ts';
import type { LogLine } from '../../shared/protocol.ts';
import type { SpriteSource } from '../render/assets.ts';
import type { PanelRect } from './panel.ts';

/**
 * How much history each lane keeps.
 *
 * The Record cap is generous because scrolling back to "what actually killed
 * me" three turns ago is the single most common reason anyone touches the log.
 * The Margin cap is smaller in absolute terms and far larger in minutes: at the
 * rate people actually talk, 160 lines is
 * most of a session.
 *
 * Both are hard caps rather than a byte budget — a `say` is capped at 500
 * characters by the schema, so the worst case is bounded and small.
 */
const RECORD_CAP = 320;
const MARGIN_CAP = 160;

/** One row of text, in logical pixels. 10px glyphs with 2px of leading. */
const ROW_H = 12;

/** Indent per `LogLine.depth` level. One level is the sample log's two spaces. */
const INDENT_PX = 8;

/**
 * The Margin's guaranteed share of the content box.
 *
 * A FRACTION *AND* A FLOOR. The fraction keeps the split sane on a tall panel;
 * the floor is what actually delivers the promise at the top of this file — on a
 * short panel the Margin still gets three rows, and the Record gives them up.
 * If the panel cannot afford the floor, the Margin wins and the Record is drawn
 * in whatever is left, because the Record has the status line, the party panel
 * and the whole map echoing it and the Margin has nowhere else to be.
 */
const MARGIN_SHARE = 0.36;
const MARGIN_MIN_ROWS = 3;

/** Rows a wheel notch or a PageUp moves. Three lines keeps the eye's place. */
export const SCROLL_STEP = 3;

const FONT_RECORD = '10px ui-monospace, Consolas, monospace';
const FONT_MARGIN = 'italic 10px ui-monospace, Consolas, monospace';
const FONT_SPEAKER = 'bold 10px ui-monospace, Consolas, monospace';
const FONT_META = 'bold 10px ui-monospace, Consolas, monospace';

export type CaseLogOptions = {
  /** Something drawable changed: a line landed, or the scroll moved. */
  readonly onChange: () => void;
};

export type CaseLogDrawOptions = {
  readonly ctx: CanvasRenderingContext2D;
  readonly sprites: SpriteSource;
  /** The panel's outer rect, in LOGICAL backbuffer pixels. */
  readonly rect: PanelRect;
  /** For the header. -1 before the first `turn` frame. */
  readonly gameTurn: number;
};

export type CaseLog = {
  /** Apply one `log` frame. Idempotent on `LogLine.seq`. */
  readonly append: (lines: readonly LogLine[]) => void;
  /**
   * Write a line the CLIENT authored, into whichever lane it belongs in.
   *
   * THE ONLY THING THAT IS ALLOWED THROUGH HERE is a transcript of something the
   * client itself observed about a frame the server sent — today, exactly one
   * caller: the combat-start and combat-end crossing (ui/combatbanner.ts), which
   * is a TRANSITION between two `turn` frames and therefore something no single
   * server line describes. It is emphatically NOT a back door for narrating game
   * rules locally: the moment the client writes its own account of a hit or a
   * save there are two vocabularies for the same event and they drift.
   *
   * It carries no `seq` because the client may not mint one — `seq` is the
   * server's monotonic counter and the de-duplication key, and a local line
   * borrowing a number from it would either be swallowed as a duplicate or
   * swallow the next real line. Local lines are stamped with 0, which the server
   * documents as "no line yet" and therefore never issues.
   */
  readonly note: (line: Omit<LogLine, 'seq'>) => void;
  /** Drop everything. A `welcome` replaces the world, and the log with it. */
  readonly clear: () => void;
  readonly draw: (options: CaseLogDrawOptions) => void;
  /** Move one lane's view. Positive scrolls BACK in time. Returns true if it moved. */
  readonly scroll: (lane: LogLane, rows: number) => boolean;
  /** Jump a lane to the newest line. What Escape and a fresh turn do. */
  readonly toBottom: (lane: LogLane) => boolean;
  /**
   * Which lane a LOGICAL backbuffer point is over, or null. Uses the rects from
   * the LAST draw, which is correct by construction: the pixels the player is
   * pointing at are the last frame.
   */
  readonly laneAt: (px: number, py: number) => LogLane | null;
  readonly visible: () => boolean;
  readonly toggle: () => boolean;
  /** The newest Margin line, for the DOM's `aria-live` mirror. Null if none. */
  readonly lastMargin: () => LogLine | null;
};

type Lane = {
  readonly lines: LogLine[];
  readonly cap: number;
  /** Entries back from the newest. 0 is pinned to the bottom and live. */
  offset: number;
  /** Lines that have arrived while scrolled up. Reset when pinned again. */
  unread: number;
  /** The band this lane last occupied, for `laneAt`. */
  rect: PanelRect;
};

const NO_RECT: PanelRect = { x: 0, y: 0, w: 0, h: 0 };

/**
 * The `seq` a locally-authored line wears. See `CaseLog.note`.
 *
 * The server's counter starts at 1 precisely so that 0 is unambiguously "no line
 * yet" (src/server/net/gateway.ts), so 0 can never collide with a real line and
 * can never move `highWater`.
 */
const LOCAL_SEQ = 0;

/**
 * Flatten anything that would break the single-line layout.
 *
 * DEFENSIVE, NOT DECORATIVE. `say` text is written by another player and a name
 * is a Discord nickname, and while neither can inject markup here — canvas
 * `fillText` has no markup, and the DOM mirror uses `textContent` — a newline or
 * a run of control characters would still let somebody push every other line out
 * of a lane, or draw a row of tofu boxes across the panel. The server should
 * strip these too; the client does not get to assume it did.
 */
function flatten(text: string): string {
  let out = '';
  let space = false;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // C0, DEL and C1. Tabs and newlines become one space; everything else goes.
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      space = true;
      continue;
    }
    if (ch === ' ') {
      space = true;
      continue;
    }
    if (space && out !== '') out += ' ';
    space = false;
    out += ch;
  }
  return out;
}

function makeLane(cap: number): Lane {
  return { lines: [], cap, offset: 0, unread: 0, rect: NO_RECT };
}

/**
 * `── turn 214 ───────────` — the separator, sized to the band.
 *
 * The dashes are COUNTED rather than repeated a fixed number of times and
 * trimmed, because trimming would append `fitText`'s ellipsis and leave the rule
 * reading "── turn 214 ─────…", which looks like truncated data rather than like
 * a rule. game-design.md § 11's sample log opens every turn with one of these,
 * and a separator that looks broken undermines the surface it is organising.
 *
 * The caller must have set the measuring font — see `fitText`.
 */
function turnRule(ctx: CanvasRenderingContext2D, gameTurn: number, maxPx: number): string {
  const head = `── turn ${gameTurn} `;
  const dashW = ctx.measureText('─').width;
  if (dashW <= 0) return head;
  const left = maxPx - ctx.measureText(head).width;
  const count = Math.max(0, Math.floor(left / dashW));
  return `${head}${'─'.repeat(count)}`;
}

export function createCaseLog(options: CaseLogOptions): CaseLog {
  const record = makeLane(RECORD_CAP);
  const margin = makeLane(MARGIN_CAP);
  let shown = true;
  /** Highest `seq` accepted. The de-duplication, and it is one comparison. */
  let highWater = 0;

  const laneOf = (lane: LogLane): Lane => (lane === LogLane.Margin ? margin : record);

  function push(lane: Lane, line: LogLine): void {
    lane.lines.push({ ...line, text: flatten(line.text) });
    if (lane.lines.length > lane.cap) {
      const dropped = lane.lines.length - lane.cap;
      lane.lines.splice(0, dropped);
      // The offset counts back from the NEWEST, so dropping from the front moves
      // the reader's anchor. Clamp rather than let it point past the start.
      lane.offset = Math.min(lane.offset, Math.max(0, lane.lines.length - 1));
    }
    if (lane.offset > 0) {
      // Scrolled up: hold the view still by walking the anchor along with the
      // arrival, and count what was missed.
      lane.offset = Math.min(lane.offset + 1, Math.max(0, lane.lines.length - 1));
      lane.unread += 1;
    }
  }

  function append(lines: readonly LogLine[]): void {
    let landed = false;
    for (const line of lines) {
      // A resync resends the tail. `seq` is monotonic and server-minted, so one
      // comparison rejects every duplicate without a set to maintain.
      if (line.seq <= highWater) continue;
      highWater = line.seq;
      push(laneOf(line.lane), line);
      landed = true;
    }
    if (landed) options.onChange();
  }

  /**
   * A client-authored line. Never touches `highWater` — see `CaseLog.note`.
   *
   * It goes through the same `push` as a server line, so it is capped, wrapped,
   * flattened and scroll-anchored identically. A local line that behaved
   * differently from a real one would be a second kind of log entry, and the
   * reader would have to learn which is which.
   */
  function note(line: Omit<LogLine, 'seq'>): void {
    push(laneOf(line.lane), { ...line, seq: LOCAL_SEQ });
    options.onChange();
  }

  function clear(): void {
    record.lines.length = 0;
    margin.lines.length = 0;
    record.offset = 0;
    margin.offset = 0;
    record.unread = 0;
    margin.unread = 0;
    highWater = 0;
    options.onChange();
  }

  function scroll(lane: LogLane, rows: number): boolean {
    const target = laneOf(lane);
    const max = Math.max(0, target.lines.length - 1);
    const next = Math.min(max, Math.max(0, target.offset + rows));
    if (next === target.offset) return false;
    target.offset = next;
    if (next === 0) target.unread = 0;
    options.onChange();
    return true;
  }

  function toBottom(lane: LogLane): boolean {
    const target = laneOf(lane);
    if (target.offset === 0 && target.unread === 0) return false;
    target.offset = 0;
    target.unread = 0;
    options.onChange();
    return true;
  }

  /**
   * Draw one lane: newest at the bottom, older above, wrapping as it walks back.
   *
   * It walks BACKWARDS from the anchor entry and stops the moment it has enough
   * rows to fill the band, so the cost is proportional to what is visible rather
   * than to the length of the history. The rows are collected in reverse and
   * drawn top-down, which is what puts the newest line flush with the bottom
   * edge even when the band is not an exact multiple of the row height.
   */
  function drawLane(
    ctx: CanvasRenderingContext2D,
    lane: Lane,
    kind: LogLane,
    rect: PanelRect,
  ): void {
    lane.rect = rect;
    const rows = Math.floor(rect.h / ROW_H);
    if (rows <= 0) return;

    const isMargin = kind === LogLane.Margin;
    ctx.font = isMargin ? FONT_MARGIN : FONT_RECORD;

    /** One drawable row, already wrapped. */
    type Row = {
      readonly text: string;
      readonly indent: number;
      readonly line: LogLine | null;
      /** True only for the first wrapped row of an entry that has a speaker. */
      readonly lead: boolean;
      /** A `── turn 12 ──` rule rather than a log line. */
      readonly rule: boolean;
    };

    const collected: Row[] = [];
    const anchor = lane.lines.length - 1 - lane.offset;
    let previousTurn: number | null = null;

    for (let i = anchor; i >= 0 && collected.length < rows; i -= 1) {
      const line = lane.lines[i];
      if (line === undefined) continue;

      // The turn separator belongs ABOVE the first line of its turn, so it is
      // emitted when the entry BELOW it (already collected) came from a later
      // turn. Record lane only: the Margin is conversation and cutting it into
      // turns would imply people speak on the clock.
      if (!isMargin && previousTurn !== null && previousTurn !== line.gameTurn) {
        collected.push({
          text: turnRule(ctx, previousTurn, rect.w),
          indent: 0,
          line: null,
          lead: false,
          rule: true,
        });
        if (collected.length >= rows) break;
      }
      previousTurn = line.gameTurn;

      const indent = Math.max(0, Math.min(2, line.depth ?? 0)) * INDENT_PX;
      const speaker = line.speaker;
      const body = speaker === undefined ? line.text : `${speaker}: ${line.text}`;

      // THE BOLD-PREFIX WIDTH DEBT. The whole line is wrapped in the LANE'S
      // font, but the `Sam:` at the front of a Margin entry is then DRAWN in a
      // bold one — which is wider, so a row measured as an exact fit would spill
      // a few pixels past the panel. Measuring the difference once and taking it
      // off the wrap width pays that debt exactly on the row that owes it, and
      // costs the continuation rows a couple of pixels they were not going to
      // use. The alternative — a hanging-indent wrapper that takes two fonts —
      // is a lot of machinery for one bold word.
      let boldDebt = 0;
      if (speaker !== undefined) {
        const prefix = `${speaker}:`;
        const plain = ctx.measureText(prefix).width;
        ctx.font = FONT_SPEAKER;
        boldDebt = Math.max(0, ctx.measureText(prefix).width - plain);
        ctx.font = isMargin ? FONT_MARGIN : FONT_RECORD;
      }
      const wrapped = wrapText(ctx, body, rect.w - indent - boldDebt);

      // Reverse, because `collected` is being built newest-first and each entry
      // must keep its own rows in reading order once the whole thing is flipped.
      for (let r = wrapped.length - 1; r >= 0 && collected.length < rows; r -= 1) {
        const text = wrapped[r];
        if (text === undefined) continue;
        collected.push({
          text,
          indent,
          line,
          lead: r === 0 && speaker !== undefined,
          rule: false,
        });
      }
    }

    // Flush to the BOTTOM of the band. `collected` is newest-first, so the last
    // element is the oldest and belongs on the top row of what is drawn.
    const drawn = collected.length;
    const bottom = rect.y + rect.h;
    for (let i = 0; i < drawn; i += 1) {
      const row = collected[i];
      if (row === undefined) continue;
      const y = bottom - (i + 1) * ROW_H + ROW_H / 2;
      const x = rect.x + row.indent;

      if (row.rule) {
        // The LANE'S font, not the header's: `turnRule` counted its dashes
        // against whatever font was current when it was built, and measuring in
        // one font while drawing in another is how a rule ends up a character
        // too long and wraps. Only the colour changes.
        ctx.fillStyle = PALETTE.GREY;
        ctx.fillText(row.text, x, y);
        continue;
      }

      // THE SPEAKER IS DRAWN SEPARATELY, and never concatenated into the text it
      // introduces. A player whose nickname is "Sam:" must not be able to make a
      // line look like Sam said it — the attribution is a different font and a
      // different colour because it comes from a different field.
      const speaker = row.line?.speaker;
      if (row.lead && speaker !== undefined) {
        const prefix = `${speaker}:`;
        ctx.font = FONT_SPEAKER;
        const prefixW = ctx.measureText(prefix).width;
        ctx.fillStyle = PALETTE.GOLD;
        ctx.fillText(prefix, x, y);
        ctx.font = isMargin ? FONT_MARGIN : FONT_RECORD;
        ctx.fillStyle = isMargin ? PALETTE.VIOLET_HI : PALETTE.PARCHMENT;
        // `row.text` starts with the prefix by construction — `wrapText` broke
        // `"Sam: hello"` on spaces — so the remainder is what follows it. The
        // guard covers a nickname long enough to be chopped mid-word.
        const rest = row.text.startsWith(prefix) ? row.text.slice(prefix.length) : ` ${row.text}`;
        ctx.fillText(rest, x + prefixW, y);
        continue;
      }

      ctx.fillStyle = isMargin ? PALETTE.VIOLET_HI : PALETTE.PARCHMENT;
      ctx.fillText(row.text, x, y);
    }

    // THE "YOU ARE NOT LIVE" BANNER. Words and a count, not a shade: a log that
    // has quietly stopped following the fight is the one state a reader must
    // never have to infer.
    if (lane.offset > 0) {
      ctx.font = FONT_META;
      ctx.fillStyle = PALETTE.ORANGE;
      const note =
        lane.unread > 0 ? `▲ scrolled back — ${lane.unread} new` : `▲ scrolled back ${lane.offset}`;
      const text = fitText(ctx, note, rect.w);
      const w = Math.ceil(ctx.measureText(text).width) + 4;
      ctx.fillStyle = PALETTE.INK;
      ctx.fillRect(rect.x, rect.y, Math.min(w, rect.w), ROW_H);
      ctx.fillStyle = PALETTE.ORANGE;
      ctx.fillText(text, rect.x + 2, rect.y + ROW_H / 2);
    }
  }

  function draw(opts: CaseLogDrawOptions): void {
    const { ctx, sprites, rect, gameTurn } = opts;
    if (!shown || rect.w <= 0 || rect.h <= 0) {
      record.rect = NO_RECT;
      margin.rect = NO_RECT;
      return;
    }

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    drawPanel(ctx, sprites, PanelSkin.Inset, rect);
    ctx.font = FONT_META;
    const headerBottom = drawHeader(
      ctx,
      sprites,
      gameTurn >= 0 ? `CASE LOG · turn ${gameTurn}` : 'CASE LOG',
      rect,
      FONT_META,
    );

    const inner = panelInner({
      x: rect.x,
      y: headerBottom,
      w: rect.w,
      h: rect.y + rect.h - headerBottom,
    });
    if (inner.h < ROW_H) {
      record.rect = NO_RECT;
      margin.rect = NO_RECT;
      ctx.restore();
      return;
    }

    // THE SPLIT. The Margin's floor wins over the Record's share — see the note
    // on MARGIN_MIN_ROWS. `divider` is one pixel of SLATE plus a labelled tab,
    // because two bands of text with no rule between them read as one list.
    const totalRows = Math.floor(inner.h / ROW_H);
    const wantMargin = Math.max(MARGIN_MIN_ROWS, Math.round(totalRows * MARGIN_SHARE));
    const marginRows = Math.min(totalRows, wantMargin);
    const recordRows = Math.max(0, totalRows - marginRows - 1);

    const recordH = recordRows * ROW_H;
    drawLane(ctx, record, LogLane.Record, { x: inner.x, y: inner.y, w: inner.w, h: recordH });

    const dividerY = inner.y + recordH + Math.floor(ROW_H / 2);
    ctx.fillStyle = PALETTE.SLATE;
    ctx.fillRect(inner.x, dividerY, inner.w, 1);
    ctx.font = FONT_META;
    ctx.fillStyle = PALETTE.INK;
    ctx.fillRect(inner.x, dividerY - 5, 44, 10);
    ctx.fillStyle = PALETTE.VIOLET_HI;
    ctx.fillText('MARGIN', inner.x + 2, dividerY);

    const marginY = dividerY + 2;
    drawLane(ctx, margin, LogLane.Margin, {
      x: inner.x,
      y: marginY,
      w: inner.w,
      h: Math.max(0, inner.y + inner.h - marginY),
    });

    ctx.restore();
  }

  function laneAt(px: number, py: number): LogLane | null {
    if (!shown) return null;
    const inside = (r: PanelRect): boolean =>
      r.w > 0 && px >= r.x - PANEL_PAD && px < r.x + r.w + PANEL_PAD && py >= r.y && py < r.y + r.h;
    if (inside(margin.rect)) return LogLane.Margin;
    if (inside(record.rect)) return LogLane.Record;
    return null;
  }

  return {
    append,
    note,
    clear,
    draw,
    scroll,
    toBottom,
    laneAt,
    visible: () => shown,
    toggle: () => {
      shown = !shown;
      options.onChange();
      return shown;
    },
    lastMargin: () => margin.lines[margin.lines.length - 1] ?? null,
  };
}
