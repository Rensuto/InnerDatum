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
  headerDragRect,
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

/**
 * One row of text, in logical pixels — 10px glyphs with 2px of leading.
 *
 * IT IS THE DEFAULT NOW, NOT THE VALUE. The cogwheel's LEAD setting is the row
 * height, so every drawing site reads `style.spacing`; this constant survives as
 * the one place that number is written down, and `DEFAULT_LOG_STYLE` takes it
 * from here so the two cannot drift.
 */
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TIMESTAMP GUTTER. `HH:MM`, in its own colour, on the first row of an
 * entry only.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * SIMPLE MEANS HOURS AND MINUTES. Seconds would change the column's width
 * every wrap and buy nothing a reader of a log wants — this answers "roughly
 * when", which is the question a scrollback asks.
 *
 * ON THE LEAD ROW ONLY, never on a wrapped continuation. A stamp repeated down
 * the left of a three-row sentence reads as three events.
 *
 * GREY, WHICH IS THE POINT OF "coloured differently". It is metadata about the
 * line rather than part of it, so it must not compete with either the ordinary
 * ink or an element's — and this is the one place `GREY` proper is right rather
 * than `GREY_HI`, because a column the eye can skip is exactly what is wanted.
 *
 * THE WIDTH IS FIXED AND MEASURED FROM A SAMPLE, not from each line: a
 * proportional-looking column would make the text start in a different place
 * on the hour a digit is added, and the font is fixed-advance anyway.
 */
const STAMP_TEXT_MAX = 5;
const STAMP_GAP = 4;

/** `14:07`, from a millisecond clock, in the viewer's own timezone. */
export function stampText(at: number): string {
  const when = new Date(at);
  const hh = String(when.getHours()).padStart(2, '0');
  const mm = String(when.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

const TAB_H = 12;
const TAB_PAD = 6;
const TAB_GAP = 2;

/** Rows a wheel notch or a PageUp moves. Three lines keeps the eye's place. */
export const SCROLL_STEP = 3;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FOUR FACES, AS A FUNCTION OF ONE SIZE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * These were four frozen strings with `10px` written into each. The cogwheel
 * makes the size a preference, and the thing that had to not happen is three of
 * them following it while the fourth stayed at ten — which is not a crash, it is
 * a log where the speaker's name is a different size from what they said.
 *
 * `FONT_META` is deliberately NOT one of them. It draws the header and the tab
 * strip, which are CHROME: they sit in a header of fixed height and a tab row of
 * fixed height, and growing their text does not grow the boxes it is in. The
 * setting is "how big is the log's text", not "how big is the window's
 * furniture" — upstream draws the same line, its font option changing body text
 * while the frames around it stay put.
 */
const STACK = 'ui-monospace, Consolas, monospace';
const fontRecord = (px: number): string => `${String(px)}px ${STACK}`;
const fontMargin = (px: number): string => `italic ${String(px)}px ${STACK}`;
const fontSpeaker = (px: number): string => `bold ${String(px)}px ${STACK}`;
const FONT_META = `bold 10px ${STACK}`;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE COGWHEEL SETS. Three lists of named steps, which is upstream's shape.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `GameOptions.lua:205-211` offers font size as a THREE-ITEM LIST POPUP —
 * Small, Normal, Big — not a slider and not a number field. That is the choice
 * worth copying: a player adjusting a log wants it readable, and three named
 * answers gets there in one press where a slider gets there in six and can stop
 * on a value that renders badly.
 *
 * Ours differ from upstream's in two ways, both improvements it could not make:
 * it is PER PANEL rather than global, and it applies IMMEDIATELY where
 * upstream's says "You must restart the game for the change to take effect".
 *
 * SPACING IS SEPARATE FROM SIZE on purpose. Tying leading to the font is the
 * obvious economy and it takes away the actual request: a reader who wants more
 * text on screen shrinks the leading and keeps the glyphs legible, and one
 * reading across a room does the opposite.
 */
export type LogStyle = {
  /** Point size of the body text. */
  readonly font: number;
  /** Backing opacity, as a percentage. 100 is opaque. */
  readonly opacity: number;
  /** Height of one row, in logical pixels. */
  readonly spacing: number;
};

const FONT_STEPS = [9, 10, 13] as const;
const OPACITY_STEPS = [40, 60, 80, 100] as const;
const SPACING_STEPS = [10, 12, 14, 17] as const;

/** What the log looks like before anybody touches the cogwheel. */
export const DEFAULT_LOG_STYLE: LogStyle = { font: 10, opacity: 100, spacing: ROW_H };

/**
 * The nearest step to a value, and the reason the wire carries values.
 *
 * A save from a build with a different step list lands on the closest thing
 * this one can draw rather than being rejected — the same degrade-don't-fail
 * the `offsets` record uses for a panel it no longer has.
 */
function snapIndex(steps: readonly number[], value: number): number {
  let best = 0;
  for (let i = 1; i < steps.length; i += 1) {
    if (Math.abs((steps[i] ?? 0) - value) < Math.abs((steps[best] ?? 0) - value)) best = i;
  }
  return best;
}

/** Pull a style onto this build's steps. Anything unreachable becomes reachable. */
export function snapStyle(style: LogStyle): LogStyle {
  return {
    font: FONT_STEPS[snapIndex(FONT_STEPS, style.font)] ?? DEFAULT_LOG_STYLE.font,
    opacity: OPACITY_STEPS[snapIndex(OPACITY_STEPS, style.opacity)] ?? DEFAULT_LOG_STYLE.opacity,
    spacing: SPACING_STEPS[snapIndex(SPACING_STEPS, style.spacing)] ?? DEFAULT_LOG_STYLE.spacing,
  };
}

/** Move one step along a list, without wrapping. Returns the new value. */
function step(steps: readonly number[], value: number, by: number): number {
  const at = snapIndex(steps, value);
  const next = Math.max(0, Math.min(steps.length - 1, at + by));
  return steps[next] ?? value;
}

/** One row of the settings popover: what it reads, and how it moves. */
const STYLE_ROWS = [
  {
    key: 'font',
    label: 'SIZE',
    steps: FONT_STEPS,
    /** Named, because "Small" is what a reader is choosing; "9" is a detail. */
    names: ['Small', 'Normal', 'Big'],
  },
  { key: 'opacity', label: 'FADE', steps: OPACITY_STEPS, names: null },
  { key: 'spacing', label: 'LEAD', steps: SPACING_STEPS, names: null },
] as const;

type StyleKey = (typeof STYLE_ROWS)[number]['key'];

export type CaseLogOptions = {
  /** Something drawable changed: a line landed, or the scroll moved. */
  readonly onChange: () => void;
  /**
   * The player moved a cogwheel stepper. Distinct from `onChange` because it
   * has to be PERSISTED as well as redrawn, and persisting is a socket message:
   * firing the save on every redraw would send one per log line.
   */
  readonly onStyleChange?: (style: LogStyle) => void;
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
  /** Is a point on the cogwheel in the header's right end? */
  readonly cogAt: (px: number, py: number) => boolean;
  /** Open or close the settings popover. Always returns true — it always moved. */
  readonly toggleSettings: () => boolean;
  /** Is the popover open? The panel's drag and scroll ask, so it can shield them. */
  readonly settingsOpen: () => boolean;
  /**
   * Handle a press inside the open popover. Returns whether it was CONSUMED —
   * true for a stepper and also for a press on the popover's own background,
   * which must not fall through to the log rows underneath it.
   */
  readonly settingsPress: (px: number, py: number) => boolean;
  readonly style: () => LogStyle;
  /** Apply a saved style. Snapped to this build's steps; fires no change event. */
  readonly setStyle: (style: LogStyle | null) => void;
  /** Is a point on the composer strip? The pointer-only route into chat. */
  readonly composerAt: (px: number, py: number) => boolean;
  /**
   * Where the real `<input>` belongs, in LOGICAL pixels, or null when the panel
   * is hidden or too short to hold a composer. From the LAST draw.
   */
  readonly composerBox: () => PanelRect | null;
  /** Tell the strip whether the player is typing. Gold prompt, no hint. */
  readonly setTyping: (typing: boolean) => void;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE LINE AS THIS CLIENT HOLDS IT: the wire's line, plus when it got here.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Asked for as *"give simple timestamps (colored differently)"*.
 *
 * ═══ THE CLOCK IS THE CLIENT'S, AND IT HAS TO BE ═══
 * There is no wall-clock anywhere on the wire, and that is deliberate twice
 * over: `src/shared/` is pure and cannot call `Date.now()` at all, and two
 * protocol docblocks explicitly refuse to send absolute time because *"the
 * client's clock is not the server's"*. Adding one would contradict both.
 *
 * `gameTurn` cannot serve either, and this is the part worth writing down: it
 * is a COMPLETED-TURN COUNTER, not a clock. An eight-line area attack stamps
 * eight lines with one identical value, and a client-authored line carries -1.
 * A column of `turn 12` repeated eight times is not a timestamp.
 *
 * ═══ SO IT IS WHEN THE LINE ARRIVED HERE, which is what a chat timestamp
 * MEANS ═══
 * Not when the rules ran — when you saw it. The two differ only on a resync,
 * where the server resends a tail and this client stamps all of it "now". That
 * is a real limitation and it is the honest one to have: the alternative is a
 * server clock rendered in a viewer's timezone, which is wrong in a different
 * and less obvious way.
 */
type Entry = LogLine & {
  /** Milliseconds since the epoch, from THIS machine, at the moment it landed. */
  readonly at: number;
};

type Lane = {
  readonly lines: Entry[];
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
  /** How it is drawn. Replaced wholesale by `settings`, stepped by the cogwheel. */
  let style: LogStyle = DEFAULT_LOG_STYLE;
  /** Is the cogwheel's popover showing? */
  let settingsShown = false;
  /** The popover's stepper buttons from the LAST draw. Empty while it is shut. */
  let stepRects: readonly {
    readonly key: StyleKey;
    readonly by: number;
    readonly rect: PanelRect;
  }[] = [];
  /** The popover's own outer rect, for the swallow-the-click test. */
  let popRect: PanelRect = NO_RECT;
  /** The composer strip from the LAST draw, or null when there was no room. */
  let composerRect: PanelRect | null = null;
  /** Is the player typing? Owned by main.ts, mirrored here for the paint. */
  let typing = false;
  /**
   * The PANEL's outer rect from the last draw — not the body's.
   *
   * `stream.rect` is the scrollable band and stops below the tabs, so the
   * cogwheel is nowhere inside it. Every other hit test here reads a rect the
   * draw captured; this is the one the header controls need.
   */
  let lastRect: PanelRect = NO_RECT;
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
  function visible(): readonly Entry[] {
    if (tab === LogTab.All) return stream.lines;
    return stream.lines.filter((line) => line.lane === tab);
  }

  function push(lane: Lane, line: LogLine): void {
    lane.lines.push({ ...line, text: flatten(line.text), at: Date.now() });
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
    lines: readonly Entry[],
    rect: PanelRect,
  ): void {
    stream.rect = rect;
    const rows = Math.floor(rect.h / style.spacing);
    if (rows <= 0) return;

    /**
     * ═══ THE FONT IS CHOSEN PER ENTRY NOW, AND IT WAS CHOSEN PER BAND ═══
     * This was one `ctx.font = isMargin ? italic : upright` above the
     * loop, which was right while a band held one lane and only one. In a merged
     * stream the italic belongs to the LINE, and — the half that would have been
     * a silent bug — `wrapText` measures against whatever font is current, so
     * leaving it hoisted would have wrapped every conversational line to the
     * width of the upright face it is not drawn in.
     */
    const fontFor = (line: Entry): string =>
      line.lane === LogLane.Margin ? fontMargin(style.font) : fontRecord(style.font);

    /**
     * MEASURED ONCE, FROM A SAMPLE, in the upright face every stamp is drawn in.
     * Measuring per line would make the text column step left and right as the
     * hour rolled over, and measuring in whatever font the last row left set is
     * the hoisted-font bug this file already carries a note about.
     */
    ctx.font = fontRecord(style.font);
    const stampW = Math.ceil(ctx.measureText('0'.repeat(STAMP_TEXT_MAX)).width) + STAMP_GAP;

    /** One drawable row, already wrapped. */
    type Row = {
      readonly text: string;
      readonly indent: number;
      readonly line: Entry | null;
      /** True only for the first wrapped row of an entry that has a speaker. */
      readonly lead: boolean;
      /**
       * True for the first wrapped row of ANY entry — which `lead` is not.
       * `lead` also requires a speaker, because it exists for the bold `Sam:`
       * prefix; the timestamp belongs on the first row of every entry, speaker
       * or not, and reusing `lead` would have stamped conversation only.
       */
      readonly first: boolean;
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
          first: false,
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
        ctx.font = fontSpeaker(style.font);
        boldDebt = Math.max(0, ctx.measureText(prefix).width - plain);
        // BACK TO THIS ENTRY'S OWN FACE, not the band's. `wrapText` on the next
        // line measures against whatever is current.
        ctx.font = fontFor(line);
      }
      // THE GUTTER IS TAKEN OUT OF THE WRAP WIDTH, not painted over the text.
      // Wrapping to the full width and then drawing a stamp on top is how a
      // column ends up sitting on the first word of every line.
      const wrapped = wrapText(ctx, body, rect.w - stampW - indent - boldDebt);

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
          first: r === 0,
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
      const y = bottom - (i + 1) * style.spacing + style.spacing / 2;
      const x = rect.x + stampW + row.indent;

      /**
       * THE STAMP, ON THE FIRST ROW OF AN ENTRY ONLY. A rule row has no line
       * and gets none; a wrapped continuation gets none either, or a three-row
       * sentence would read as three events.
       */
      if (row.line !== null && row.first) {
        ctx.font = fontRecord(style.font);
        ctx.fillStyle = PALETTE.GREY;
        ctx.fillText(stampText(row.line.at), rect.x, y);
      }

      if (row.rule) {
        // THE FACE `turnRule` MEASURED ITSELF IN. It counted its dashes against
        // whatever font was current when it was built, and measuring in one
        // font while drawing in another is how a rule ends up a character too
        // long and wraps. That used to be guaranteed by the band's single
        // `ctx.font`; in a merged stream the previous row may have left the
        // italic set, so it is stated.
        ctx.font = fontRecord(style.font);
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
        ctx.font = fontSpeaker(style.font);
        const prefixW = ctx.measureText(prefix).width;
        ctx.fillStyle = PALETTE.GOLD;
        ctx.fillText(prefix, x, y);
        ctx.font = rowMargin ? fontMargin(style.font) : fontRecord(style.font);
        ctx.fillStyle = ink;
        // `row.text` starts with the prefix by construction — `wrapText` broke
        // `"Sam: hello"` on spaces — so the remainder is what follows it. The
        // guard covers a nickname long enough to be chopped mid-word.
        const rest = row.text.startsWith(prefix) ? row.text.slice(prefix.length) : ` ${row.text}`;
        ctx.fillText(rest, x + prefixW, y);
        continue;
      }

      ctx.font = rowMargin ? fontMargin(style.font) : fontRecord(style.font);
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
      ctx.fillRect(rect.x, rect.y, Math.min(w, rect.w), style.spacing);
      ctx.fillStyle = PALETTE.ORANGE;
      ctx.fillText(text, rect.x + 2, rect.y + style.spacing / 2);
    }
  }

  function draw(opts: CaseLogDrawOptions): void {
    const { ctx, sprites, rect, gameTurn } = opts;
    if (!shown || rect.w <= 0 || rect.h <= 0) {
      stream.rect = NO_RECT;
      tabRects = [];
      stepRects = [];
      lastRect = NO_RECT;
      composerRect = null;
      return;
    }
    lastRect = rect;

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE FADE IS ON THE FRAME AND NEVER ON THE TEXT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Asked for as *"an opacy setting"*, and the naive reading — set
     * `globalAlpha` for the whole panel and restore at the end — is the one that
     * makes the feature useless. At 40% the words go with the backing and the
     * player has traded a log they can read for a log they can see through.
     *
     * What a transparent log window is actually FOR is seeing the map underneath
     * while still reading the words on top. So the alpha covers the backing and
     * the header strip, and everything drawn into them — rows, tabs, timestamps,
     * the cogwheel — is painted at full strength afterwards.
     */
    ctx.globalAlpha = style.opacity / PERCENT;
    drawPanel(ctx, sprites, PanelSkin.Inset, rect);
    ctx.font = FONT_META;
    const headerBottom = drawHeader(
      ctx,
      sprites,
      gameTurn >= 0 ? `CASE LOG · turn ${gameTurn}` : 'CASE LOG',
      rect,
      FONT_META,
    );
    ctx.globalAlpha = 1;

    const inner = panelInner({
      x: rect.x,
      y: headerBottom,
      w: rect.w,
      h: rect.y + rect.h - headerBottom,
    });
    if (inner.h < style.spacing) {
      stream.rect = NO_RECT;
      tabRects = [];
      /**
       * THE COGWHEEL AND ITS MENU BOTH STAY LIVE on a panel too short to draw a
       * row in. It is the control that makes the rows fit again — a player who
       * squeezed the log and then raised the leading would otherwise be
       * stranded with no way back.
       *
       * `drawSettings` is called rather than skipped for a second reason: it is
       * what CLEARS `stepRects` when the menu is shut. Returning early past it
       * would leave the last full draw's buttons in place — invisible, and still
       * answering presses.
       */
      drawSettings(ctx, sprites, rect, inner);
      drawLogCog(ctx, rect, settingsShown);
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
    /**
     * THE TRANSCRIPT STOPS ABOVE THE COMPOSER. The real `<input>` is opaque and
     * floats over the canvas, so any row drawn under it is permanently
     * invisible — not dim, not clipped, gone.
     */
    const composer = logComposerRect(rect);
    const bodyBottom = inner.y + inner.h - (composer === null ? 0 : LOG_COMPOSER_H);
    drawStream(ctx, visible(), {
      x: inner.x,
      y: bodyY,
      w: inner.w,
      h: Math.max(0, bodyBottom - bodyY),
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE STRIP IS PAINTED WHETHER OR NOT THE INPUT IS SHOWING.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Two reasons, and the second is the one that matters. It is the visible
     * ANSWER to "where do I type" — Enter opens the field, and a player who has
     * not learned that yet needs somewhere to point at. And the DOM row is
     * hidden in every frame where the canvas is showing something else (the
     * class picker, the world map, a modal), so without a painted strip the
     * panel would change shape depending on what else is on screen.
     */
    if (composer !== null) {
      ctx.fillStyle = PALETTE.SLATE;
      ctx.fillRect(composer.x, composer.y, composer.w, 1);
      ctx.font = FONT_META;
      ctx.fillStyle = typing ? PALETTE.GOLD : PALETTE.GREY;
      ctx.fillText('>', composer.x + 2, composer.y + LOG_COMPOSER_H / 2 + 1);
      if (!typing) {
        ctx.fillStyle = PALETTE.GREY;
        ctx.font = fontRecord(style.font);
        ctx.fillText(
          fitText(ctx, 'Enter to talk', composer.w - COMPOSER_TEXT_X),
          composer.x + COMPOSER_TEXT_X,
          composer.y + LOG_COMPOSER_H / 2 + 1,
        );
      }
    }
    composerRect = composer;

    drawSettings(ctx, sprites, rect, inner);
    drawLogCog(ctx, rect, settingsShown);

    ctx.restore();
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE COGWHEEL'S POPOVER: three rows of `- value +`, over the log's own body.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * STEPPERS RATHER THAN A SLIDER, which is `GameOptions.lua:208`'s list popup
   * in the space available: three named answers reached in one press. A slider
   * on a canvas is a drag gesture, and this panel already has two of those
   * (move by the header, resize by the grip) — a third that starts inside the
   * body would have to be disentangled from the scroll.
   *
   * DRAWN LAST AND OVER THE BODY, not beside it. There is nowhere beside it: the
   * log is docked to the bottom-left corner and can be resized down to 160x72,
   * so a popover anchored outside would be off-screen at the size the player is
   * most likely to have chosen. Over the body it is always reachable, and the
   * body is the one thing whose appearance the player is currently judging —
   * three rows of chrome across it is a fair price for seeing the change land.
   *
   * IT IS CLAMPED INTO THE PANEL, not merely positioned inside it. On a log
   * squeezed to its floor the popover is taller than the body; it takes the
   * space it needs and the rows behind it are simply covered, which is honest,
   * where a popover drawn past the edge would have half its buttons unpressable.
   */
  function drawSettings(
    ctx: CanvasRenderingContext2D,
    sprites: SpriteSource,
    outer: PanelRect,
    inner: PanelRect,
  ): void {
    if (!settingsShown) {
      stepRects = [];
      popRect = NO_RECT;
      return;
    }

    ctx.font = FONT_META;
    const w = Math.min(POP_W, Math.max(PANEL_MIN_POP_W, outer.w - PANEL_PAD * 2));
    const h = STYLE_ROWS.length * POP_ROW_H + PANEL_PAD * 2;
    // Right-aligned under the cogwheel it belongs to, then pulled back inside.
    const x = Math.max(outer.x + PANEL_PAD, outer.x + outer.w - PANEL_PAD - w);
    /**
     * IT PREFERS THE TOP OF THE BODY AND IS PULLED UP TO FIT.
     *
     * At the panel's floor (72 tall, 24 of it header) the popover is taller than
     * the body it is drawn in, and it HANGS below the panel rather than being
     * cropped or squeezed. That is the deliberate choice of the two: a menu with
     * a row off the bottom edge has a control nobody can press, and shaving the
     * rows until three of them fit inside 48 pixels makes every one of them
     * unreadable. It is painted last and over the map, and it never leaves the
     * viewport — the log's band already reserves the hotbar's height beneath it.
     *
     * The cost is that it covers the resize grip. That is why the press handler
     * asks the popover BEFORE the grip: while the menu is open the pixels belong
     * to what the player can see.
     */
    const y = Math.max(outer.y + HEADER_H, Math.min(inner.y, outer.y + outer.h - PANEL_PAD - h));
    const box: PanelRect = { x, y, w, h };
    popRect = box;

    // THE CASE-FILE SKIN, WHICH IS THE OTHER ONE. The log itself is Inset — a
    // recess in the interface — and a popover drawn in the same skin would look
    // like a hole inside a hole. CaseFile reads as a card laid on top, which is
    // what this is.
    drawPanel(ctx, sprites, PanelSkin.CaseFile, box);

    const placed: { key: StyleKey; by: number; rect: PanelRect }[] = [];
    for (let i = 0; i < STYLE_ROWS.length; i += 1) {
      const row = STYLE_ROWS[i];
      if (row === undefined) continue;
      const rowY = box.y + PANEL_PAD + i * POP_ROW_H;
      const mid = rowY + POP_ROW_H / 2;

      ctx.font = FONT_META;
      ctx.fillStyle = PALETTE.GREY_HI;
      ctx.fillText(row.label, box.x + PANEL_PAD, mid);

      const value = style[row.key];
      const at = snapIndex(row.steps, value);
      // NAMED WHERE UPSTREAM NAMES IT, numeric where a number is the thing:
      // "Small" is what a reader is choosing for a size, but nobody wants "Fade:
      // Medium" when the honest answer is a percentage they can compare.
      const shownValue =
        row.names === null
          ? row.key === 'opacity'
            ? `${String(value)}%`
            : String(value)
          : (row.names[at] ?? String(value));

      const minusX = box.x + box.w - PANEL_PAD - POP_BTN * 2 - POP_VALUE_W - POP_GAP * 2;
      const valueX = minusX + POP_BTN + POP_GAP;
      const plusX = valueX + POP_VALUE_W + POP_GAP;

      for (const [bx, by, glyph] of [
        [minusX, -1, '−'],
        [plusX, 1, '+'],
      ] as const) {
        const btn: PanelRect = { x: bx, y: rowY + 1, w: POP_BTN, h: POP_ROW_H - 2 };
        placed.push({ key: row.key, by, rect: btn });
        // AT AN END, THE BUTTON IS DIM AND STILL PRESSABLE. `step` clamps, so
        // the press is a no-op; greying it says so before the player wonders
        // whether the control is broken.
        const dead = by < 0 ? at === 0 : at === row.steps.length - 1;
        ctx.fillStyle = PALETTE.INK;
        ctx.fillRect(btn.x, btn.y, btn.w, btn.h);
        ctx.fillStyle = dead ? PALETTE.GREY : PALETTE.GOLD;
        ctx.textAlign = 'center';
        ctx.fillText(glyph, btn.x + btn.w / 2, mid);
        ctx.textAlign = 'left';
      }

      ctx.fillStyle = PALETTE.PARCHMENT;
      ctx.textAlign = 'center';
      ctx.fillText(fitText(ctx, shownValue, POP_VALUE_W), valueX + POP_VALUE_W / 2, mid);
      ctx.textAlign = 'left';
    }
    stepRects = placed;
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

  function toggleSettings(): boolean {
    settingsShown = !settingsShown;
    options.onChange();
    return true;
  }

  /**
   * A press inside the open popover.
   *
   * IT SWALLOWS EVERY PRESS ON ITSELF, not only the ones that land on a button.
   * The popover floats over the log's rows, and a press on its background that
   * fell through would scroll or select whatever is underneath — which reads as
   * the panel doing something at random while a menu is open.
   */
  function settingsPress(px: number, py: number): boolean {
    if (!shown || !settingsShown) return false;
    for (const btn of stepRects) {
      if (!inside(btn.rect, px, py)) continue;
      const row = STYLE_ROWS.find((each) => each.key === btn.key);
      if (row === undefined) return true;
      const next = step(row.steps, style[btn.key], btn.by);
      if (next === style[btn.key]) return true;
      style = { ...style, [btn.key]: next };
      options.onChange();
      options.onStyleChange?.(style);
      return true;
    }
    return inside(popRect, px, py);
  }

  /**
   * Take a saved style, or reset to the default when there is none.
   *
   * SNAPPED, and it fires no `onStyleChange`: this is the SERVER telling the
   * client what the player chose, and echoing it straight back would be a write
   * caused by a read — on every `settings` frame, including the one at join.
   */
  function setStyle(next: LogStyle | null): void {
    style = next === null ? DEFAULT_LOG_STYLE : snapStyle(next);
    options.onChange();
  }

  /**
   * Is a LOGICAL backbuffer point on the composer strip?
   *
   * Pointing at the place you type is the pointer-only route to chat, and it is
   * the only one: `Enter` is a keyboard, and a Discord Activity on a tablet has
   * no keyboard until something focuses a field.
   */
  function composerAt(px: number, py: number): boolean {
    if (!shown || composerRect === null) return false;
    const r = composerRect;
    return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
  }

  /** Where the DOM input goes, in LOGICAL pixels, or null when it cannot. */
  function composerBox(): PanelRect | null {
    return shown ? composerRect : null;
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
    cogAt: (px: number, py: number): boolean =>
      shown && lastRect.w > 0 && logCogAt(lastRect, px, py),
    toggleSettings,
    settingsOpen: (): boolean => settingsShown,
    settingsPress,
    style: (): LogStyle => style,
    setStyle,
    composerAt,
    composerBox,
    setTyping: (next: boolean): void => {
      if (next === typing) return;
      typing = next;
      options.onChange();
    },
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
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE COMPOSER STRIP — where you type, at the foot of the transcript.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Asked for as *"the chat bar below it needs to be removed and added to the
 * 'case log' to active chat"*.
 *
 * ═══ AT THE FOOT, WHERE THE TABS ARE AT THE HEAD, AND THEY ARE NOT THE SAME
 * KIND OF THING ═══
 * The tab strip's own note argues for the top: *"a strip at the FOOT would sit
 * where the newest line is — the one place in a log a reader's eye is already
 * fixed"*. That is right about CHROME and wrong about a COMPOSER. Every chat
 * client ever built puts the box you type into at the bottom, and the reason is
 * the same adjacency the tabs were avoiding: what you are about to say belongs
 * directly under the last thing that was said.
 *
 * ═══ IT STOPS SHORT OF THE GRIP, AND THAT IS NOT COSMETIC ═══
 * `logGripRect` is the bottom-right `LOG_GRIP_PX` square of the OUTER rect. The
 * real `<input>` is positioned over this box, and a DOM element cannot be
 * hit-tested through — a full-width composer would sit on top of the resize
 * grip and the Case Log could never be resized again.
 *
 * ═══ NULL WHEN THERE IS NO ROOM ═══
 * A panel squeezed to its floor cannot hold a header, a tab row, a composer AND
 * a line of transcript. The transcript wins: a log you cannot read is worse
 * than a log you cannot type into, and the player can still talk by making the
 * box bigger.
 */
export const LOG_COMPOSER_H = 18;

export function logComposerRect(rect: PanelRect): PanelRect | null {
  const inner = panelInner({
    x: rect.x,
    y: rect.y + HEADER_H,
    w: rect.w,
    h: rect.h - HEADER_H,
  });
  // The tab row and one row of transcript have to survive it.
  if (inner.h < TAB_H + ROW_H + LOG_COMPOSER_H) return null;
  return {
    x: inner.x,
    y: inner.y + inner.h - LOG_COMPOSER_H,
    w: Math.max(0, inner.w - LOG_GRIP_PX),
    h: LOG_COMPOSER_H,
  };
}

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
  const strip = headerDragRect(rect, PANEL_PAD + COG_PX);
  return px >= strip.x && px < strip.x + strip.w && py >= strip.y && py < strip.y + strip.h;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE COGWHEEL, IN THE HEADER'S RIGHT END.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Asked for as *"a cogwheel settings button ... on the case log pane at the top
 * right of the pane"*, and it is where the other panels put their close control
 * — the right end of the header strip is this client's settled place for a
 * header button, and a player looking for one looks there.
 *
 * THE HANDLE HAS TO GIVE UP THE PIXELS, which is why `logDragAt` above is now
 * `headerDragRect(rect, PANEL_PAD + COG_PX)` and not the full strip it used to
 * be. `ui/panel.ts` carries the note about what happens otherwise: a header that
 * looks grabbable everywhere starts a drag when you press the control, which
 * then fires on mouseup having moved the panel first. That is not a hypothetical
 * here — the full-width version shipped, and the cogwheel is the first thing to
 * be put in the strip it was claiming.
 */
export const COG_PX = 13;

export function logCogRect(rect: PanelRect): PanelRect {
  return {
    x: rect.x + rect.w - PANEL_PAD - COG_PX,
    y: rect.y + Math.floor((HEADER_H - COG_PX) / 2),
    w: COG_PX,
    h: COG_PX,
  };
}

/** True when a LOGICAL backbuffer point is on the cogwheel. */
export function logCogAt(rect: PanelRect, px: number, py: number): boolean {
  const cog = logCogRect(rect);
  return px >= cog.x && px < cog.x + cog.w && py >= cog.y && py < cog.y + cog.h;
}

/**
 * A GEAR, DRAWN RATHER THAN BLITTED, for `drawLogGrip`'s reason: a control that
 * is the only way to reach a setting must not be invisible behind a missing PNG.
 * `icon_ui_cog` is logged in ASSETS-REQUIRED.md to replace it; until then this
 * is a hub, a bore and six teeth, which at thirteen pixels is all a gear is.
 *
 * It brightens when the popover is open, so the button says whether the thing it
 * opens is showing — the same signal the tab strip gives.
 */
export function drawLogCog(ctx: CanvasRenderingContext2D, rect: PanelRect, open: boolean): void {
  const cog = logCogRect(rect);
  const cx = cog.x + cog.w / 2;
  const cy = cog.y + cog.h / 2;
  const outer = cog.w / 2;

  ctx.save();
  ctx.fillStyle = open ? PALETTE.GOLD : PALETTE.GREY_HI;
  // The teeth: six spokes, each a short stroke from the body out to the rim.
  ctx.strokeStyle = open ? PALETTE.GOLD : PALETTE.GREY_HI;
  ctx.lineWidth = 2;
  for (let i = 0; i < COG_TEETH; i += 1) {
    const angle = (i / COG_TEETH) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * (outer - 3), cy + Math.sin(angle) * (outer - 3));
    ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
    ctx.stroke();
  }
  // The body, then the bore punched back out of it in the header's own colour.
  ctx.beginPath();
  ctx.arc(cx, cy, outer - 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = PALETTE.INK;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1, outer - 3 - 2), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

const COG_TEETH = 6;

/**
 * The popover's numbers. `POP_W` is what the three rows want; a log narrower
 * than that gets `PANEL_MIN_POP_W` and the value column ellipsises, which is
 * better than buttons that overlap.
 */
const POP_W = 168;
const PANEL_MIN_POP_W = 120;
const POP_ROW_H = 16;
const POP_BTN = 14;
const POP_GAP = 3;
const POP_VALUE_W = 52;

/** Where the composer's text starts, past the `>` prompt. */
const COMPOSER_TEXT_X = 10;

/** Denominator for the opacity percentage. */
const PERCENT = 100;
