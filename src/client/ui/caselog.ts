/**
 * THE CASE LOG. One running stream, and tabs to ask a question of it.
 *
 * ===========================================================================
 * IT WAS TWO LANES, AND THE ARGUMENT FOR THAT IS WORTH KEEPING
 * ===========================================================================
 * game-design.md § 11 writes the log as **Record** (terse, mechanical, cream)
 * and **Margin** (italic, violet — the Index's voice, and the players' own).
 * They arrive at wildly different rates:
 *
 *   RECORD — what the rules did. One Alchemic Vial produces five lines; a sweep
 *     of eight monsters produces twenty. In a fight it is a firehose.
 *   MARGIN — what a PERSON said. Perhaps three lines a minute, and every one of
 *     them is the reason four people are in a voice channel playing this
 *     instead of playing it alone.
 *
 * So the Margin held a RESERVED BAND at the foot of the panel that the Record
 * could not spend, with its own scroll position. The Record could be as loud as
 * it liked and the last three things anybody said were still on screen.
 *
 * ===========================================================================
 * IT IS ONE STREAM NOW, BY REQUEST, AND THE TABS ARE WHAT PAY FOR IT
 * ===========================================================================
 * Asked for as *"one merged stream, but have TABS in the box to separate the
 * other game information, player chat, etc."*
 *
 * THE RISK THE OLD DESIGN NAMED IS REAL AND IS NOW LIVE: in a fight, twenty
 * lines of arithmetic scroll past between "get to me" and anyone reading it.
 * What answers it is no longer a reserved band but a filter — the MARGIN tab
 * shows the conversation with no combat between it, which the two-band layout
 * could not do at all. A reserved three rows and a tab that shows every line
 * anybody has said are different answers to the same question, and the second
 * one is what was asked for.
 *
 * ONE BUFFER, AND IT HAS TO BE. Two arrays cannot be merged back into arrival
 * order after the fact: `seq` would order the server's lines but a
 * client-authored one carries `seq = 0`, so sorting by it piles every refusal
 * at the top of the log. See `STREAM_CAP`.
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
import { DAMAGE_INK, PALETTE } from '../render/canvas.ts';
import {
  HEADER_H,
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
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE BUFFER, AND IT HAS TO BE ONE FOR THE STREAM TO INTERLEAVE AT ALL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This was two: 320 Record lines and 160 Margin ones, in separate arrays. Two
 * arrays cannot be merged back into arrival order after the fact — `seq` is the
 * server's monotonic counter and would do it for server lines, but a
 * client-authored line carries `seq = 0` (see `note`), so sorting by it would
 * pile every refusal and every combat crossing at the very top of the log.
 *
 * So the stream is stored in the order it arrived, which is the order it
 * happened, and the tabs FILTER it rather than the buffers dividing it.
 *
 * THE CAP IS THE OLD TWO ADDED TOGETHER, so a session holds as much history as
 * it did. What it no longer holds is a GUARANTEED share for conversation: a
 * long fight can now push chat out of the buffer, which two capped arrays made
 * impossible. That is the cost of the merge, and the TALK tab is what pays for
 * it — the lines are still there while they are in the buffer at all, and the
 * tab shows them with no combat between them.
 */
const STREAM_CAP = 320 + 160;

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
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TABS. Requested as *"TABS in the box to separate the other game
 * information, player chat, etc."*
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ UPSTREAM'S HUD LOG HAS NONE, AND ITS POPUP DOES ═══
 * `engine/LogDisplay.lua` is 317 lines with no tab, channel or stream concept —
 * it renders exactly one list. `UserChat.lua:747-762` CAN draw channel tabs and
 * both shipped uisets switch them off (`Minimalist.lua:480`, `Classic.lua:79`).
 * Where tabs actually live in ToME is the full-screen popup,
 * `dialogs/ShowChatLog.lua:46-55`, whose row is `[Game Log]` followed by one
 * tab per chat channel.
 *
 * So this is ToME's tab row on ToME's log box — the two halves it keeps apart,
 * put together, which is what was asked for.
 *
 * ═══ THREE, AND THE THIRD CANNOT BE NARROWED ═══
 * `LogLine.lane` is the only thing on the wire that separates one kind of line
 * from another, so the tabs are ALL, the RECORD lane, and the MARGIN lane.
 *
 * "MARGIN" AND NOT "CHAT", because it is not only chat: a player's `say` and an
 * NPC's greeting are byte-identical on the wire — both arrive as
 * `{ lane: Margin, speaker: <name> }` — so a tab labelled CHAT would quietly
 * include everything the townsfolk say. Margin is this game's own word for the
 * lane (game-design.md § 11) and it is the honest one. Separating a person from
 * a character would need a new wire field, not a new filter.
 */
export const LogTab = {
  All: 'all',
  Record: 'record',
  Margin: 'margin',
} as const;
export type LogTab = (typeof LogTab)[keyof typeof LogTab];

export const LOG_TABS: readonly LogTab[] = [LogTab.All, LogTab.Record, LogTab.Margin];

/** What each tab is called on its button. Short: the strip is one row. */
const TAB_LABEL: Readonly<Record<LogTab, string>> = {
  [LogTab.All]: 'ALL',
  [LogTab.Record]: 'RECORD',
  [LogTab.Margin]: 'MARGIN',
};

const TAB_H = 12;
const TAB_PAD = 6;
const TAB_GAP = 2;

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
   * client itself observed about a frame the server sent. It is emphatically NOT
   * a back door for narrating game rules locally: the moment the client writes
   * its own account of a hit or a save there are two vocabularies for the same
   * event and they drift.
   *
   * TWO CALLERS TODAY, and the line between them and the forbidden case is
   * WHO DECIDED, not who composed the sentence:
   *
   *   the combat crossing (ui/combatbanner.ts) — a TRANSITION between two `turn`
   *     frames, which no single server line describes.
   *   a server refusal (`case 'error'`) — the server DECLINED and said so in a
   *     frame; `refusalText` only renders that code into a sentence, and the
   *     banner and this line use the same one so a player is not told two
   *     different things about one keypress.
   *
   * Neither client COMPUTES an outcome. That is the rule, and the count above
   * used to read "exactly one caller" long after the second one landed — which
   * is worth more than the pedantry: this docblock is the API's rule, and a
   * stale one sends the next reader to rebuild something that already exists.
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
  /** Move the view. Positive scrolls BACK in time. Returns true if it moved. */
  readonly scroll: (rows: number) => boolean;
  /** Jump to the newest line. What Escape and a fresh turn do. */
  readonly toBottom: () => boolean;
  /**
   * Is a LOGICAL backbuffer point over the scrollable body? Uses the rect from
   * the LAST draw, which is correct by construction: the pixels the player is
   * pointing at are the last frame.
   *
   * `laneAt`'s replacement — that answered WHICH of two bands, because each had
   * its own scroll position. There is one now.
   */
  readonly bodyAt: (px: number, py: number) => boolean;
  /** Which tab button a point is on, or null. */
  readonly tabAt: (px: number, py: number) => LogTab | null;
  /** Show a different tab. Returns true if it changed. */
  readonly selectTab: (tab: LogTab) => boolean;
  readonly activeTab: () => LogTab;
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
  const stream = makeLane(STREAM_CAP);
  /**
   * ALWAYS TRUE, AND KEPT AS A NAMED CONSTANT RATHER THAN DELETED.
   *
   * `toggle()` and `visible()` were removed with the two-lane API — they had
   * zero callers anywhere in src/ or test/, because visibility is main.ts's
   * `logVisible`, which drives whether `unmovedPanelRect` returns a rect at all.
   * The widget is never asked to draw itself hidden.
   *
   * The guards that read this stay: they are what makes `draw` and the two hit
   * tests refuse in one place if that ever stops being true.
   */
  const shown = true;
  /** Which tab is showing. `All` is the one the log opens on. */
  let tab: LogTab = LogTab.All;
  /** The tab buttons from the LAST draw, for the hit test. Empty before one. */
  let tabRects: readonly { readonly tab: LogTab; readonly rect: PanelRect }[] = [];
  /** Highest `seq` accepted. The de-duplication, and it is one comparison. */
  let highWater = 0;

  /**
   * The lines the active tab shows, oldest first.
   *
   * FILTERED AT DRAW TIME rather than kept as three arrays. The buffer is the
   * history and a tab is a QUESTION about it; three arrays would be three
   * things to cap, three to scroll-anchor and three to keep in step, to save a
   * walk over at most 480 entries once per frame — and the renderer is a
   * dirty-flag one, so that frame only happens when something changed.
   */
  function visible(): readonly LogLine[] {
    if (tab === LogTab.All) return stream.lines;
    return stream.lines.filter((line) => line.lane === tab);
  }

  function push(lane: Lane, line: LogLine): void {
    lane.lines.push({ ...line, text: flatten(line.text) });
    if (lane.lines.length > lane.cap) {
      const dropped = lane.lines.length - lane.cap;
      lane.lines.splice(0, dropped);
      // The offset counts back from the NEWEST, so dropping from the front moves
      // the reader's anchor. Clamp rather than let it point past the start.
      lane.offset = Math.min(lane.offset, Math.max(0, lane.lines.length - 1));
    }
    if (stream.offset > 0) {
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
      push(stream, line);
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
    push(stream, { ...line, seq: LOCAL_SEQ });
    options.onChange();
  }

  function clear(): void {
    stream.lines.length = 0;
    stream.offset = 0;
    stream.unread = 0;
    highWater = 0;
    options.onChange();
  }

  /**
   * Move the view. Positive scrolls BACK in time.
   *
   * IT TAKES NO LANE ANY MORE. There was one offset per lane and a caller had to
   * say which — the keyboard used Shift to pick, and the wheel asked `laneAt`
   * which band the pointer was over. With one stream there is one view, and the
   * question "which of these am I scrolling" has stopped existing.
   *
   * COUNTED IN ENTRIES OF THE FILTERED LIST, so a tab showing thirty lines
   * scrolls through thirty rather than through the whole buffer behind it.
   */
  function scroll(rows: number): boolean {
    const max = Math.max(0, visible().length - 1);
    const next = Math.min(max, Math.max(0, stream.offset + rows));
    if (next === stream.offset) return false;
    stream.offset = next;
    if (next === 0) stream.unread = 0;
    options.onChange();
    return true;
  }

  function toBottom(): boolean {
    if (stream.offset === 0 && stream.unread === 0) return false;
    stream.offset = 0;
    stream.unread = 0;
    options.onChange();
    return true;
  }

  /**
   * Switch tab, and go to the bottom when it changes.
   *
   * THE OFFSET IS RESET RATHER THAN REMEMBERED PER TAB. It counts entries back
   * from the newest of the FILTERED list, so the same number means a different
   * place in each tab — carrying it across would drop the reader somewhere
   * arbitrary, and remembering three would be three anchors to keep valid
   * against one buffer that is still being appended to and capped.
   *
   * Going to the bottom is also what a player pressing a tab means: show me
   * this, now.
   */
  function selectTab(next: LogTab): boolean {
    if (next === tab) return false;
    tab = next;
    stream.offset = 0;
    stream.unread = 0;
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
  function drawStream(
    ctx: CanvasRenderingContext2D,
    lines: readonly LogLine[],
    rect: PanelRect,
  ): void {
    stream.rect = rect;
    const rows = Math.floor(rect.h / ROW_H);
    if (rows <= 0) return;

    /**
     * ═══ THE FONT IS CHOSEN PER ENTRY NOW, AND IT WAS CHOSEN PER BAND ═══
     * This was one `ctx.font = isMargin ? FONT_MARGIN : FONT_RECORD` above the
     * loop, which was right while a band held one lane and only one. In a merged
     * stream the italic belongs to the LINE, and — the half that would have been
     * a silent bug — `wrapText` measures against whatever font is current, so
     * leaving it hoisted would have wrapped every conversational line to the
     * width of the upright face it is not drawn in.
     */
    const fontFor = (line: LogLine): string =>
      line.lane === LogLane.Margin ? FONT_MARGIN : FONT_RECORD;

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
    const anchor = lines.length - 1 - stream.offset;
    let previousTurn: number | null = null;

    for (let i = anchor; i >= 0 && collected.length < rows; i -= 1) {
      const line = lines[i];
      if (line === undefined) continue;

      ctx.font = fontFor(line);

      /**
       * The turn separator belongs ABOVE the first line of its turn, so it is
       * emitted when the entry BELOW it (already collected) came from a later
       * turn.
       *
       * RECORD ENTRIES ONLY, AND THE TEST IS ON THE LINE NOW. It was
       * `!isMargin` — a fact about the BAND — which meant exactly the same
       * thing while a band held one lane. In a merged stream that test is
       * always true, so every conversational line would be cut into turns, and
       * the reason it never was is the reason it still must not be: the Margin
       * is people talking, and ruling it by the clock implies they speak on it.
       */
      if (line.lane !== LogLane.Margin && previousTurn !== null && previousTurn !== line.gameTurn) {
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
        // BACK TO THIS ENTRY'S OWN FACE, not the band's. `wrapText` on the next
        // line measures against whatever is current.
        ctx.font = fontFor(line);
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
        // THE FACE `turnRule` MEASURED ITSELF IN. It counted its dashes against
        // whatever font was current when it was built, and measuring in one
        // font while drawing in another is how a rule ends up a character too
        // long and wraps. That used to be guaranteed by the band's single
        // `ctx.font`; in a merged stream the previous row may have left the
        // italic set, so it is stated.
        ctx.font = FONT_RECORD;
        ctx.fillStyle = PALETTE.GREY;
        ctx.fillText(row.text, x, y);
        continue;
      }

      // THE SPEAKER IS DRAWN SEPARATELY, and never concatenated into the text it
      // introduces. A player whose nickname is "Sam:" must not be able to make a
      // line look like Sam said it — the attribution is a different font and a
      // different colour because it comes from a different field.
      const speaker = row.line?.speaker;
      /**
       * PER ROW, from the entry the row came from — the band no longer answers
       * this. A rule row has no line and takes the upright face, which is what
       * it was drawn in before and what `turnRule` measured itself against.
       */
      const rowMargin = row.line !== null && row.line.lane === LogLane.Margin;
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * THE ELEMENT TINTS THE LINE — `LogLine.damage`, and `DAMAGE_INK` for the
       * colour upstream gives it.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * ABSENT MEANS THE ORDINARY INK, never a default element: a heal rides the
       * same frame with no type at all, and every Record line that is not a blow
       * has none either. Tinting those would say six things happened when one
       * did.
       *
       * THE MARGIN OUTRANKS IT AND CANNOT LOSE. A conversational line is violet
       * because of WHO said it, which is a fact about the lane rather than about
       * the rules; the wire cannot put a `damage` on one today, and if it ever
       * could, a person's words must not be repainted by an element.
       */
      const element = row.line?.damage;
      const ink = rowMargin
        ? PALETTE.VIOLET_HI
        : element === undefined
          ? PALETTE.PARCHMENT
          : DAMAGE_INK[element];
      if (row.lead && speaker !== undefined) {
        const prefix = `${speaker}:`;
        ctx.font = FONT_SPEAKER;
        const prefixW = ctx.measureText(prefix).width;
        ctx.fillStyle = PALETTE.GOLD;
        ctx.fillText(prefix, x, y);
        ctx.font = rowMargin ? FONT_MARGIN : FONT_RECORD;
        ctx.fillStyle = ink;
        // `row.text` starts with the prefix by construction — `wrapText` broke
        // `"Sam: hello"` on spaces — so the remainder is what follows it. The
        // guard covers a nickname long enough to be chopped mid-word.
        const rest = row.text.startsWith(prefix) ? row.text.slice(prefix.length) : ` ${row.text}`;
        ctx.fillText(rest, x + prefixW, y);
        continue;
      }

      ctx.font = rowMargin ? FONT_MARGIN : FONT_RECORD;
      ctx.fillStyle = ink;
      ctx.fillText(row.text, x, y);
    }

    // THE "YOU ARE NOT LIVE" BANNER. Words and a count, not a shade: a log that
    // has quietly stopped following the fight is the one state a reader must
    // never have to infer.
    if (stream.offset > 0) {
      ctx.font = FONT_META;
      ctx.fillStyle = PALETTE.ORANGE;
      const note =
        stream.unread > 0
          ? `▲ scrolled back — ${stream.unread} new`
          : `▲ scrolled back ${stream.offset}`;
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
      stream.rect = NO_RECT;
      tabRects = [];
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
      stream.rect = NO_RECT;
      tabRects = [];
      ctx.restore();
      return;
    }

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE TAB STRIP, WHERE THE DIVIDER USED TO BE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The panel used to be split into two bands with a labelled rule between
     * them, the Margin holding a reserved share the Record could not spend.
     * There is one band now and the tabs choose what is in it.
     *
     * ACROSS THE TOP, under the header, because that is where
     * `ShowChatLog.lua:46-55` puts its row and because a strip at the FOOT would
     * sit where the newest line is — the one place in a log a reader's eye is
     * already fixed.
     *
     * MEASURED, NOT LAID OUT ON A GRID. `ui/panel.ts` has no button row and the
     * three labels differ in width, so each takes the width of its own text
     * plus a pad, which is `Tab.lua:49`'s `w = text_w + 11` in this client's
     * units.
     */
    ctx.font = FONT_META;
    const placed: { tab: LogTab; rect: PanelRect }[] = [];
    let tabX = inner.x;
    for (const each of LOG_TABS) {
      const label = TAB_LABEL[each];
      const w = Math.ceil(ctx.measureText(label).width) + TAB_PAD;
      const box: PanelRect = { x: tabX, y: inner.y, w, h: TAB_H };
      placed.push({ tab: each, rect: box });

      const active = each === tab;
      ctx.fillStyle = active ? PALETTE.SLATE : PALETTE.INK;
      ctx.fillRect(box.x, box.y, box.w, box.h);
      // THE ACTIVE ONE IS UNDERLINED AS WELL AS FILLED. Colour alone is never
      // the only signal on this surface -- the rule the party pane keeps.
      if (active) {
        ctx.fillStyle = PALETTE.GOLD;
        ctx.fillRect(box.x, box.y + box.h - 1, box.w, 1);
      }
      ctx.fillStyle = active ? PALETTE.GOLD : PALETTE.GREY_HI;
      ctx.fillText(label, box.x + Math.floor(TAB_PAD / 2), box.y + TAB_H / 2);
      tabX += w + TAB_GAP;
    }
    tabRects = placed;

    const bodyY = inner.y + TAB_H + 2;
    drawStream(ctx, visible(), {
      x: inner.x,
      y: bodyY,
      w: inner.w,
      h: Math.max(0, inner.y + inner.h - bodyY),
    });

    ctx.restore();
  }

  const inside = (r: PanelRect, px: number, py: number): boolean =>
    r.w > 0 && px >= r.x - PANEL_PAD && px < r.x + r.w + PANEL_PAD && py >= r.y && py < r.y + r.h;

  /**
   * Is a LOGICAL backbuffer point over the scrollable body?
   *
   * `laneAt`'s replacement. That answered WHICH of two bands the pointer was
   * over, because each had its own scroll position; there is one now, so the
   * only question left is whether the wheel belongs to the log at all — and if
   * it does not, main.ts falls through to the map zoom.
   *
   * Uses the rect from the LAST draw, which is correct by construction: the
   * pixels the player is pointing at are the last frame.
   */
  function bodyAt(px: number, py: number): boolean {
    return shown && inside(stream.rect, px, py);
  }

  /** Which tab button a point is on, or null. Rects from the last draw. */
  function tabAt(px: number, py: number): LogTab | null {
    if (!shown) return null;
    for (const placed of tabRects) {
      if (inside(placed.rect, px, py)) return placed.tab;
    }
    return null;
  }

  return {
    append,
    note,
    clear,
    draw,
    scroll,
    toBottom,
    bodyAt,
    tabAt,
    selectTab,
    activeTab: () => tab,
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CORNER GRIP — one square, at the box's inside bottom-right.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ported from `Minimalist.lua:310`:
 *
 *     gamelog = { x = function(self) return self.logdisplay.w - move_handle[6] end,
 *                 y = function(self) return self.logdisplay.h - move_handle[6] end }
 *
 * — the handle's own width subtracted from the box's, on both axes, so it sits
 * INSIDE the corner rather than hanging off it. Upstream's is a loaded PNG whose
 * pixel size this tree does not carry (no `.png` exists anywhere under
 * `reference/`, the media is not redistributable), so the number below is ours;
 * the placement arithmetic is upstream's exactly.
 *
 * ═══ ONE HANDLE, TWO GESTURES, WHICH IS ALSO UPSTREAM'S ═══
 * `Minimalist.lua:1693` registers this same zone for both: a LEFT drag moves the
 * box (`:578`) and a RIGHT drag resizes it (`:585`, `mode = "resize"`). Two
 * separate grips would be this client inventing a control ToME does not have,
 * on a box whose whole point is to be the one ToME ships.
 */
export const LOG_GRIP_PX = 12;

/** Where the grip is, for the painter and the hit test to share one answer. */
export function logGripRect(rect: PanelRect): PanelRect {
  return {
    x: rect.x + rect.w - LOG_GRIP_PX,
    y: rect.y + rect.h - LOG_GRIP_PX,
    w: LOG_GRIP_PX,
    h: LOG_GRIP_PX,
  };
}

/** True when a LOGICAL backbuffer point is on the grip. */
export function logGripAt(rect: PanelRect, px: number, py: number): boolean {
  const grip = logGripRect(rect);
  return px >= grip.x && px < grip.x + grip.w && py >= grip.y && py < grip.y + grip.h;
}

/**
 * Three diagonal ticks in the corner, which is the vocabulary every resizable
 * window on every desktop uses. Upstream blits an authored PNG; this is drawn,
 * for `ASSETS-REQUIRED.md`'s reason — a widget that needs art to be USABLE
 * cannot ship behind a missing file.
 */
export function drawLogGrip(ctx: CanvasRenderingContext2D, rect: PanelRect): void {
  const grip = logGripRect(rect);
  ctx.save();
  ctx.strokeStyle = PALETTE.GREY_HI;
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i += 1) {
    const inset = i * 3;
    ctx.beginPath();
    // +0.5 so a one-pixel line lands ON a pixel rather than across two.
    ctx.moveTo(grip.x + grip.w - inset + 0.5, grip.y + grip.h - 0.5);
    ctx.lineTo(grip.x + grip.w - 0.5, grip.y + grip.h - inset + 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HEADER STRIP IS THE MOVE HANDLE — and this is a DIVERGENCE, stated.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Upstream drives BOTH gestures off the corner handle: left-drag moves the box
 * and right-drag resizes it (`Minimalist.lua:578` and `:585`, one zone
 * registered for both at `:1693`).
 *
 * THE RIGHT BUTTON IS ALREADY SPOKEN FOR HERE. It scrolls the view, everywhere,
 * on every pixel of the canvas — so a right-drag that resized the log would be
 * a second meaning for a button a player is already holding to look around, and
 * the two would fight on exactly the box they overlap.
 *
 * So the gestures split the way THIS client already splits them: the four
 * panels that move all move by their header, and a corner grip is the universal
 * vocabulary for a resize. A player who has dragged the character sheet knows
 * how to move this without being told, which is worth more than matching which
 * mouse button upstream happened to choose.
 */
export function logDragAt(rect: PanelRect, px: number, py: number): boolean {
  return px >= rect.x && px < rect.x + rect.w && py >= rect.y && py < rect.y + HEADER_H;
}
