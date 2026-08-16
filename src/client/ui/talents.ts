/**
 * THE TALENT PANEL: four talents, what each one does now, what one point buys,
 * and the `+` that buys it.
 *
 * ===========================================================================
 * IT IS A DOCK PANEL, NOT A MODAL, AND THAT IS THE WHOLE DESIGN
 * ===========================================================================
 * ToME's `LevelupDialog` is a registered dialog: `engine/Game.lua:380-381` calls
 * `d.key:setCurrent()` when one opens, so it SEIZES the keyboard, and it then
 * rebinds ACCEPT and all four MOVE_* for its own tree widget
 * (dialogs/elements/TalentTrees.lua:145-151). ToME can afford that because ToME
 * is single player and the world is paused while you shop.
 *
 * THIS GAME CANNOT, and the reason is the one ui/charsheet.ts:5-27 already
 * states in full: five other people are at the barrier, `isBlocking` has no
 * notion of "is reading a menu", and porting that focus capture would mean one
 * player deciding where to put a point holds the whole party until the Bell
 * fires on them. So this is a PANEL. It swallows no keys, no turn verbs and no
 * hotbar slots; a player reading it can still walk, still commit, still hold,
 * still press 1-4; and THE SERVER IS NEVER TOLD IT IS OPEN. A player who reads
 * instead of acting is exactly a player who is thinking, and the Warrant Clock
 * auto-passes them after the Bell like anyone else (engine/barrier.ts).
 *
 * That single decision is why `talentPanelRect` takes a BAND rather than a
 * viewport — `charSheetRect` is the model it copies. Clamped between `top` and
 * `bottom`, the panel can never come to rest over the hotbar, the resource strip
 * or the prose lines, so every control the player might reach for stays visible
 * and pressable underneath it. It is ANCHORED TO THE TOP of that band rather
 * than centred in it, which is the one place it differs from the sheet: both are
 * centred horizontally because the two docks own the sides, and two panels
 * centred on the same point would sit exactly on top of each other the moment a
 * player opened both. Top-anchored, they miss each other entirely on any band
 * tall enough for both, and on a short one the paint order in main.ts decides.
 *
 * ===========================================================================
 * IT IS A LIST, NOT A TREE, AND ToME SHIPS THIS EXACT DEGENERATE CASE
 * ===========================================================================
 * `export type Talent` (src/server/engine/talents.ts) has id, name, classId,
 * iconId, cost, cooldownTurns, targeting, damageType, onUse and describe — NO
 * category, NO tier, NO prerequisite — and `ClassDef.loadout` is exactly four
 * talents. So a "tree" here would be one category containing four nodes with no
 * edges between them, which is a list wearing chrome.
 *
 * WHAT IS PORTED IS THE ELEMENT, NOT THE TOPOLOGY: TalentTrees.lua:361-457 draws
 * an icon, a frame around it, and the `n/max` status string centred UNDER the
 * frame (:429-433), and that is what a row is here. ToME itself ships the
 * one-node-per-tree case and this is the precedent to copy — LevelupDialog.lua
 * :737-755 builds a `TalentTrees` with `no_cross = true` over the stat column,
 * where every "tree" is a single node and the expander is switched off. Note
 * also that ToME draws no connectors and no tier rows ANYWHERE: prerequisites
 * live only in tooltip prose, never as structure.
 *
 * ===========================================================================
 * SPENDING IS IRREVOCABLE HERE, AND THE CONFIRM PRESS IS A DEVIATION
 * ===========================================================================
 * LABELLED AS A DEVIATION SO NOBODY READS IT AS A PORT. ToME spends LIVE against
 * a full clone of the actor (`backup`/`restore`, LevelupDialog.lua:38-53) and
 * commits only at the Escape prompt (:121-147, "Do you accept changes?"), with
 * `cancel()` restoring the clone wholesale (:161-164). There is no cheap
 * server-side analogue: a per-actor draft is a second source of truth that would
 * have to survive a disconnect, an autosave and a floor reset, and the moment it
 * did not, a player would be holding points the file does not have.
 *
 * So the spend is immediate and the safety is a SECOND PRESS on the same row.
 * That costs a misclick nothing and costs the design nothing — the choice is
 * still made with the current->next diff on screen — and it needs no draft, no
 * new frame and no state on the server. `pressSpend` below is the whole of it.
 *
 * THERE IS NO REFUND GESTURE THIS PASS. Right-click is deliberately not bound on
 * this panel at all, so there is no half-implemented unlearn to discover: ToME's
 * `isUnlearnable` window (LevelupDialog.lua:930-943) depends on
 * `last_learnt_talents`, which we do not persist.
 *
 * ===========================================================================
 * GEOMETRY IS PURE AND SHARED. ONE COPY OF THE ARITHMETIC
 * ===========================================================================
 * `talentPanelGeometry` is called by the painter AND by `talentPanelHitAt`, and
 * neither takes a context. ui/partypanel.ts:93-99 records what the second copy
 * costs: a button that lands a row above where it is drawn, on somebody else's
 * window size only. ui/contextmenu.ts:24-34 records why a hit test may not hold a
 * context — it would have to remember a rect from the last frame, and a surface
 * that has never been drawn would then swallow clicks at 0,0.
 *
 * ===========================================================================
 * NO SCROLLING, AND THE DROP IS SAID IN WORDS
 * ===========================================================================
 * Four rows do not need it, and ui/charsheet.ts:80-92 already argues the
 * principle: a scroll position is state, state needs a scrollbar, and a
 * scrollbar needs a hit test. When the band genuinely cannot hold four rows the
 * tail is dropped and a NOTE ROW SAYS SO, taking ui/caselog.ts:467-478's rule
 * that a surface which has quietly stopped showing everything must never make
 * the reader infer it.
 *
 * ===========================================================================
 * ZERO NEW SPRITE IDS, AND THE FRAME HAS TO CARRY THE MEANING WITHOUT ART
 * ===========================================================================
 * `LoadoutTalent.icon` is an asset KEY off the wire and it is passed through
 * verbatim, exactly as ui/charsheet.ts and ui/classpicker.ts:338 do. Nothing
 * here writes an `icon_active_*` literal and nothing assembles a key from a name.
 *
 * ═══ THE ICONS RESOLVE NOW, AND THIS PARAGRAPH USED TO SAY THEY NEVER DID ═══
 * It read: "TODAY THAT KEY NEVER RESOLVES: `icon_active_*` is under no prefix in
 * main.ts's `NEEDED_ASSET_PREFIXES`, so every talent icon on the hotbar, the
 * sheet, the picker and this panel is the letter-plate fallback." That was true
 * for the whole of M3-M6 and it is FALSE NOW: the loader filtered on a dead
 * `icon_ability_` spelling that matched nothing, while all twelve talents
 * declare `iconId: 'icon_active_<name>'` (src/server/talents/*.ts) and all twelve
 * 64x64 PNGs were on disk. `icon_active_` is in the prefix list and the icons
 * blit — centre-cropped 1:1 into the 24-pixel box below, never scaled.
 *
 * WHAT DOES NOT CHANGE IS THE FALLBACK, and it is not dead code: the manifest is
 * gitignored wholesale (CLAUDE.md), so a fresh clone with no art must still be
 * fully playable. The frame, the `n/max` label, the `+`/`MAX` glyph and the
 * selection ring stay `fillRect`/`fillText` — the same way ui/classpicker.ts
 * :403-411 draws its selection ring — so the panel is legible with the art and
 * without it. ToME's `ui/plus.png` and `ui/minus.png` (TalentTrees.lua's
 * `self.plus`/`self.minus`) are still deliberately NOT ported as ids.
 *
 * ===========================================================================
 * NEVER COLOUR ALONE
 * ===========================================================================
 * ui/partypanel.ts:78-92 states the rule and this panel is a case it exists for.
 * ToME colours the `n/max` status three ways and nothing else
 * (LevelupDialog.lua:537-549): green at the cap, white when the talent can be
 * learned, grey when it cannot. We keep the three colours AND give each a glyph
 * that survives greyscale:
 *
 *   AT THE CAP        gold digits, and the word MAX where the button would be
 *   A POINT IN HAND   parchment digits, and a drawn `+` BUTTON
 *   NOTHING TO SPEND  grey digits, and nothing at all in that slot
 *
 * Any one of the three can be lost and the state still reads.
 *
 * It draws into the BACKBUFFER at logical scale like every other ui/ module —
 * see the long note at the top of render/canvas.ts.
 */

import { PALETTE } from '../render/canvas.ts';
import {
  drawButton,
  drawHeader,
  drawPanel,
  fitText,
  headerDragRect,
  HEADER_H,
  PANEL_PAD,
  PanelSkin,
} from './panel.ts';
import type { LoadoutTalent, ProgressMsg } from '../../shared/protocol.ts';
import type { SpriteSource } from '../render/assets.ts';
import type { PanelRect } from './panel.ts';

// ---------------------------------------------------------------------------
// Geometry constants. See the header before changing any of them.
// ---------------------------------------------------------------------------

/**
 * Chrome lost on each side. Mirrors `panelInner`'s inset, as ui/tooltip.ts does.
 *
 * NOTHING IN THIS FILE SIZES A BOX FROM A CHARACTER COUNT, which is why there is
 * no `CHAR_W` here as there is in ui/charsheet.ts and ui/classpicker.ts. Every
 * string on this panel is a server-rendered sentence of unknown length, so every
 * one of them goes through `fitText` against the real inner width at paint time
 * and no two are positioned against each other.
 */
const INSET = PANEL_PAD + 3;

/**
 * The icon box, and the status line under it.
 *
 * 24 rather than the sheet's 18: this is the screen where a talent is chosen
 * rather than glanced at, and the `n/max` beneath it has to be centred on
 * something wide enough to read the digits against. The label sits UNDER the
 * frame, which is where TalentTrees.lua:429-433 puts it.
 */
const ICON_PX = 24;
const LEVEL_LABEL_H = 11;

/** Air between the icon column and the prose column. */
const ICON_GAP = 6;

/** One talent row: the icon stack on the left, three lines of prose on the right. */
const TALENT_ROW_H = ICON_PX + LEVEL_LABEL_H + 8;
/** The points badge, and the note that replaces a dropped row. */
const POINTS_ROW_H = 14;
const NOTE_ROW_H = 12;

/** The `+` control. Square-ish, so it is a target rather than a glyph. */
const PLUS_W = 20;
const PLUS_H = 14;

/** The close control, top-right of the header strip. Square, so it is a target. */
const CLOSE_PX = 13;

/** Preferred and minimum size of the panel itself. */
const PANEL_W = 320;
const PANEL_MIN_W = 176;
const PANEL_MAX_H = 252;
/**
 * A panel that cannot hold its header plus ONE talent row is not worth drawing.
 *
 * One row rather than four, deliberately: the drop policy below removes rows
 * from the tail and says so in words, so a short band gives a truthful partial
 * panel. Refusing to open at all until four fit would leave a player pressing a
 * key that appears to do nothing.
 */
const PANEL_MIN_H = HEADER_H + INSET * 2 + TALENT_ROW_H;
/** Air between the panel and the edges of the band it is clamped into. */
const PANEL_MARGIN = 6;

const FONT_NAME = 'bold 10px ui-monospace, Consolas, monospace';
const FONT_BODY = '10px ui-monospace, Consolas, monospace';
const FONT_LEVEL = 'bold 10px ui-monospace, Consolas, monospace';
const FONT_META = 'bold 10px ui-monospace, Consolas, monospace';
/** The first-letter fallback inside an icon box. Non-violet, by rule. */
const FONT_ICON_FALLBACK = 'bold 12px ui-monospace, Consolas, monospace';

/**
 * The title on the header strip, and the LEVEL that goes on it.
 *
 * ═══ THE SCREEN WHOSE WHOLE SUBJECT IS LEVELLING USED TO NEVER STATE THE LEVEL ═══
 * ToME titles this exact dialog with the actor it is about —
 * `Dialog.init(self, "Levelup: "..actor.name, ...)` at LevelupDialog.lua:88 —
 * because a spend screen that does not say WHOSE points these are is a screen
 * you can be looking at without knowing what it is. Ours has one actor and
 * needs no name; what it was missing is the number every one of its rows is
 * about. `TALENTS · Lv 3`.
 *
 * THE LEVEL COMES IN ON THE DRAW OPTIONS, NOT AS A STRING. Handing this file a
 * finished title would put the formatting in main.ts, and then the day somebody
 * wants "Lv" spelled differently there would be two files to find. The caller
 * passes the number; this file owns every glyph on its own header.
 *
 * NULL FALLS BACK TO THE BARE WORD rather than to `Lv 0` or `Lv ?`. `progress`
 * is unicast in the `hello` block, so a null is a one-frame window on connect
 * and never a level-zero character — the same rule ui/charsheet.ts:344-347
 * states about the same frame.
 */
const PANEL_TITLE = 'TALENTS';

function panelTitle(level: number | null | undefined): string {
  if (level === null || level === undefined || !Number.isFinite(level)) return PANEL_TITLE;
  return `${PANEL_TITLE} · Lv ${String(Math.max(0, Math.floor(level)))}`;
}

/**
 * THE ARROW THAT MAKES THE DIFF A DIFF.
 *
 * ToME writes the same relation as `" [->"` … `"]"` around the two values
 * (LevelupDialog.lua:953-955's `diff` closure, used at :969-970). One glyph
 * rather than four characters because our two values are whole SENTENCES on
 * separate lines rather than two numbers inline, and a leading arrow is what
 * marks the second line as "and this is what the point buys" without a label.
 */
const ARROW = '→';
/** The word half of the at-cap signal. See the header: never colour alone. */
const MAX_WORD = 'MAX';
/** The word half of the a-point-is-available signal. */
const PLUS_LABEL = '+';
/** The `+` once it is armed. A different GLYPH, not merely a different colour. */
const PLUS_ARMED_LABEL = '+?';

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * The three kinds of line the panel can hold.
 *
 * A const object plus a derived type rather than an `enum`: `erasableSyntaxOnly`
 * is on and an enum emits runtime code the type-stripping loader refuses.
 */
export const TalentRowKind = {
  /**
   * "3 points to spend", "no points — next at level 7", "top level — no more
   * points". Present whenever the `progress` frame is, at any count. See
   * `pointsText` for why the COUNT is unconditional and the PLATE is not.
   */
  Points: 'points',
  /** Icon, name, `n/max`, the current->next diff, and the `+`. The workhorse. */
  Talent: 'talent',
  /** A sentence about the panel itself — what was dropped, or that nothing came. */
  Note: 'note',
} as const;
export type TalentRowKind = (typeof TalentRowKind)[keyof typeof TalentRowKind];

export type TalentRow =
  | {
      readonly kind: typeof TalentRowKind.Points;
      /** Points in hand. ZERO IS A VALID VALUE and draws the second or third state. */
      readonly unspent: number;
      /** The whole sentence, composed by `pointsText`. One copy, read by the painter. */
      readonly text: string;
    }
  | {
      readonly kind: typeof TalentRowKind.Talent;
      /** The NAMESPACED talent id, which is what `spend_point` names. */
      readonly id: string;
      readonly name: string;
      /** An asset KEY off the wire, never derived from the name. */
      readonly icon: string;
      /** Index into the loadout — slot 1 is 0. Carried so a hit names a slot. */
      readonly index: number;
      /** RAW level: points actually spent. LevelupDialog.lua:952 uses the raw one. */
      readonly level: number;
      readonly maxLevel: number;
      /** What it does NOW, rendered server-side. */
      readonly desc: string;
      /** What it does one point from now. NULL at the cap — there is no next. */
      readonly descNext: string | null;
      /** True when a point is in hand AND the talent is below its cap. */
      readonly canSpend: boolean;
    }
  | { readonly kind: typeof TalentRowKind.Note; readonly text: string };

/**
 * Everything the panel is built from. Two frames, and neither is enough alone.
 *
 * `loadout` carries the four talents WITH their levels, caps and the two
 * descriptions — all four of those fields arrived on the wire at v9 precisely so
 * this panel would not have to compute anything (protocol.ts's `LoadoutTalent`).
 * `progress` carries the points in hand, and it is viewer-private for the reason
 * `ProgressMsg` gives: an unspent point is INTENT.
 */
export type TalentPanelView = {
  /** The `loadout` frame, in HOTBAR ORDER. Never sorted here. */
  readonly loadout: readonly LoadoutTalent[];
  /** The `progress` frame, or null before the first one arrives. */
  readonly progress: ProgressMsg | null;
};

/**
 * THE POINTS LINE, IN THREE STATES, AND THE COUNT IS UNCONDITIONAL.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS REVERSES WHAT THIS FILE USED TO SAY, AND THE OLD CITATION WAS READ FROM
 * THE WRONG HALF OF ITS OWN PRECEDENT
 * ═══════════════════════════════════════════════════════════════════════════
 * The paragraph that stood here read: "THE POINTS BADGE IS CONDITIONAL,
 * mirroring ToME's own conditional hotspot: uiset/Minimalist.lua:1587-1589 only
 * makes the levelup plate clickable `and (player.unused_stats > 0 or
 * player.unused_talents > 0 or ...)`, and :1512-1516 only draws its glow under
 * the same test. A badge reading '0 points' on every open would be furniture
 * within one session."
 *
 * Both citations are real and both are about the HUD's levelup PLATE — a
 * call-to-action out on the frame, which is correctly conditional and still is
 * (see the gold plate below, and ui/charsheet.ts's own points row, which stays
 * conditional for exactly this reason). What they are NOT about is the spend
 * SCREEN. Upstream's own levelup dialog carries four point counters —
 * `text="Stats: "..self.actor.unused_stats`, `"Class points: "`,
 * `"Generic points: "`, `"Category points: "` at LevelupDialog.lua:757-784 —
 * and every one of them is ALWAYS PRESENT, including at zero, and is
 * regenerated after every single spend (:1001-1008 rewrites all four `.text`
 * fields and calls `:generate()` on each). What is conditional there is the
 * EMPHASIS: `glow = 0.6` at :690-691, set only when the matching counter is
 * above zero. Each counter also carries prose about where the next point comes
 * from — "Each level you gain 1 new class point to use. Each five levels you
 * gain one more." (:623-624).
 *
 * So the correct port is: THE COUNT IS ALWAYS THERE, THE EMPHASIS IS NOT. What
 * the old reading produced was a spend screen that, at zero points, showed four
 * rows each advertising "→ (something better)" with no count, no button and no
 * sentence anywhere saying where the next point comes from — a screen that says
 * nothing about the only question it exists to answer.
 *
 * THE THIRD STATE IS THE CAP, and it is detected from the `xpToNext === 0`
 * SENTINEL rather than from a new wire field or a client-side copy of
 * `MAX_CHARACTER_LEVEL` (shared/protocol.ts:3301-3305 argues against the
 * second; the first is a protocol change for a sentence). "next at level 11"
 * for a level-10 character would be a promise the game cannot keep.
 */
function pointsText(progress: ProgressMsg): string {
  if (progress.unspent > 0) {
    return progress.unspent === 1 ? '1 point to spend' : `${progress.unspent} points to spend`;
  }
  // The cap. `xpToNext` is 0 there and is never a denominator — ui/charsheet.ts
  // :428-441 and ui/xpbar.ts handle the same sentinel the same way.
  if (!Number.isFinite(progress.xpToNext) || progress.xpToNext <= 0) {
    return 'top level — no more points';
  }
  return `no points — next at level ${String(Math.floor(progress.level) + 1)}`;
}

/**
 * THE PANEL, AS AN ORDERED LIST OF LINES. Pure, and the whole port lives here.
 *
 * THE ORDER IS THE LOADOUT'S ORDER AND IS NEVER SORTED. `LoadoutMsg` promises
 * slot 1 is `talents[0]` and asks the client not to re-rank it; a panel that
 * listed talents by level, or alphabetically, would teach a different order from
 * the one under the player's fingers on the hotbar — and this is the screen
 * where somebody decides which of those four keys to make better.
 *
 * THE POINTS ROW IS UNCONDITIONAL ON THE COUNT AND CONDITIONAL ON THE FRAME.
 * See `pointsText` for the port and for what it reverses. It still needs the
 * `progress` frame to exist, because two of its three states name a LEVEL and
 * the third is read off `xpToNext` — with nothing to read, "next at level 1" is
 * a wrong number stated confidently, which ui/charsheet.ts:344-347 refuses for
 * the same frame in the same one-frame window on connect.
 */
export function talentPanelRows(view: TalentPanelView): readonly TalentRow[] {
  const rows: TalentRow[] = [];
  const progress = view.progress;
  const unspent = progress?.unspent ?? 0;
  if (progress !== null) {
    rows.push({ kind: TalentRowKind.Points, unspent, text: pointsText(progress) });
  }

  if (view.loadout.length === 0) {
    // NEVER A BLANK BOX. `loadout` is unicast in the `hello` block, so this is a
    // one-frame window on connect — but an empty panel in that window is
    // indistinguishable from a broken one, and the player's next move is to
    // press the key again.
    rows.push({ kind: TalentRowKind.Note, text: 'waiting for your loadout…' });
    return rows;
  }

  for (let i = 0; i < view.loadout.length; i += 1) {
    const talent = view.loadout[i];
    if (talent === undefined) continue;
    rows.push({
      kind: TalentRowKind.Talent,
      id: talent.id,
      name: talent.name,
      icon: talent.icon,
      index: i,
      level: talent.level,
      maxLevel: talent.maxLevel,
      desc: talent.desc,
      descNext: talent.descNext,
      // BOTH HALVES, and the server checks both again on arrival. This decides
      // whether a BUTTON is drawn; the gateway decides whether a spend happens,
      // and answers `bad_message` for a capped talent or an empty hand however
      // this panel looked at the time.
      canSpend: unspent > 0 && talent.level < talent.maxLevel,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The confirm press — the deviation, as a pure state machine
// ---------------------------------------------------------------------------

/**
 * What a press on a row's `+` means, given what was already armed.
 *
 * THE WHOLE OF THE DEVIATION DESCRIBED IN THE HEADER, in one pure function so
 * that the rule is testable without a DOM and so main.ts holds nothing but the
 * armed id. Three cases and no fourth:
 *
 *   nothing armed          -> ARM this row, send nothing
 *   this row armed         -> DISARM and SPEND
 *   a DIFFERENT row armed  -> re-arm on the new row, send nothing
 *
 * The third case is the one worth stating: a player who armed Ward Rush and then
 * pressed Fog Step has changed their mind, and treating the second press as a
 * confirmation of the FIRST row would spend an irreversible point on the talent
 * they just moved away from.
 */
export type SpendPress = {
  /** The new armed id, or null when nothing is armed any more. */
  readonly armed: string | null;
  /** The talent to send `spend_point` for, or null for "send nothing". */
  readonly spend: string | null;
};

export function pressSpend(armed: string | null, talentId: string): SpendPress {
  if (armed === talentId) return { armed: null, spend: talentId };
  return { armed: talentId, spend: null };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * WHERE THE PANEL GOES, or null when the band it was given cannot hold one.
 *
 * CLAMPED INTO THE BAND, which is the point: `top` is the first free pixel under
 * the top HUD and `bottom` is the first pixel of the bottom bands, so the panel
 * can never come to rest over the hotbar, the resource strip or the prose lines.
 * `height` is the logical viewport and clamps `bottom` in turn — a caller that
 * computed a band against a stale viewport size cannot push the panel off the
 * bottom of the screen, where its close button would be unreachable.
 *
 * CENTRED HORIZONTALLY because both sides are taken (ui/partypanel.ts holds the
 * left, the Case Log holds the right), and ANCHORED TO THE TOP of the band
 * because the character sheet is centred in it — see the header.
 */
export function talentPanelRect(options: {
  /** Logical backbuffer width, in world pixels — not device pixels. */
  readonly width: number;
  /** Logical backbuffer height. Clamps `bottom`; see above. */
  readonly height: number;
  /** First free pixel under the top HUD. */
  readonly top: number;
  /** First pixel of the bottom bands (the hotbar and the prose lines). */
  readonly bottom: number;
}): PanelRect | null {
  const { width, height, top } = options;
  const bottom = Math.min(options.bottom, height);
  const band = bottom - top;
  if (band < PANEL_MIN_H + PANEL_MARGIN * 2) return null;
  if (width < PANEL_MIN_W + PANEL_MARGIN * 2) return null;

  const w = Math.min(PANEL_W, width - PANEL_MARGIN * 2);
  const h = Math.min(PANEL_MAX_H, band - PANEL_MARGIN * 2);
  return { x: Math.floor((width - w) / 2), y: top + PANEL_MARGIN, w, h };
}

/**
 * THE CLOSE CONTROL'S RECT — the ONE copy of that arithmetic.
 *
 * Depends on the panel rect alone and never on the rows, which is what lets the
 * hit test answer for a panel whose contents have not been computed this frame.
 */
function closeRect(rect: PanelRect): PanelRect {
  return {
    x: rect.x + rect.w - PANEL_PAD - CLOSE_PX,
    y: rect.y + Math.floor((HEADER_H - CLOSE_PX) / 2),
    w: CLOSE_PX,
    h: CLOSE_PX,
  };
}

/** How many vertical pixels one row wants. */
function rowHeight(row: TalentRow): number {
  switch (row.kind) {
    case TalentRowKind.Points:
      return POINTS_ROW_H;
    case TalentRowKind.Talent:
      return TALENT_ROW_H;
    case TalentRowKind.Note:
      return NOTE_ROW_H;
  }
}

/** One row, placed, with the `+` it may or may not have. */
export type PlacedTalentRow = {
  readonly row: TalentRow;
  readonly rect: PanelRect;
  /**
   * The `+` control, or null when there is nothing to buy.
   *
   * NULL AT THE CAP AND NULL WITH AN EMPTY HAND, and it is the same null: a
   * control that is drawn and refuses is worse than one that is not drawn, on a
   * panel whose entire subject is what you can afford.
   */
  readonly plus: PanelRect | null;
};

export type TalentPanelGeometry = {
  readonly close: PanelRect;
  /** Rows in reading order, top to bottom. */
  readonly placed: readonly PlacedTalentRow[];
};

/**
 * EVERYTHING INSIDE THE PANEL, IN ONE PASS. The painter's only source of truth
 * about where a row lands, and the owner of the drop policy.
 *
 * Rows are placed top-down and the TAIL is dropped when the band runs out —
 * never the middle, and never half a row. A talent row cut off after its name
 * would show a level with no statement of what it does, which is precisely the
 * lie the current->next diff exists to prevent. When anything is dropped, a NOTE
 * takes the last line and says how many went (ui/caselog.ts:467-478,
 * ui/charsheet.ts:615).
 */
export function talentPanelGeometry(
  rect: PanelRect,
  rows: readonly TalentRow[],
): TalentPanelGeometry {
  const close = closeRect(rect);
  const x = rect.x + INSET;
  const innerW = Math.max(0, rect.w - INSET * 2);
  const top = rect.y + HEADER_H + INSET;
  const bottom = rect.y + rect.h - INSET;

  // ═══ THE NOTE'S LINE IS RESERVED ONLY WHEN THERE IS GOING TO BE A NOTE ═══
  // Measured in one pass first, rather than reserved row by row: a per-row
  // lookahead would hold back twelve pixels on a panel where everything fits,
  // and the fourth talent — the one the drop policy exists to protect — would be
  // dropped to make room for a message saying it had been dropped.
  const total = rows.reduce((sum, row) => sum + rowHeight(row), 0);
  const limit = top + total <= bottom ? bottom : bottom - NOTE_ROW_H;

  const placed: PlacedTalentRow[] = [];
  let cursor = top;
  let dropped = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row === undefined) continue;
    const h = rowHeight(row);
    if (cursor + h > limit) {
      dropped = rows.length - i;
      break;
    }

    const rowRect: PanelRect = { x, y: cursor, w: innerW, h };
    const plus =
      row.kind === TalentRowKind.Talent && row.canSpend
        ? { x: rowRect.x + rowRect.w - PLUS_W, y: rowRect.y + 1, w: PLUS_W, h: PLUS_H }
        : null;
    placed.push({ row, rect: rowRect, plus });
    cursor += h;
  }

  if (dropped > 0 && cursor + NOTE_ROW_H <= bottom) {
    const what = dropped === 1 ? '1 talent hidden' : `${dropped} talents hidden`;
    placed.push({
      row: { kind: TalentRowKind.Note, text: `${what} — panel too small` },
      rect: { x, y: cursor, w: innerW, h: NOTE_ROW_H },
      plus: null,
    });
  }

  return { close, placed };
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

export const TalentHitKind = {
  /** The × on the header. The mouse's copy of the key that opened the panel. */
  Close: 'close',
  /** A row's `+`. The caller runs it through `pressSpend`. */
  Spend: 'spend',
  /** Somewhere on a talent row, but not on its `+`. Cosmetic — it hovers. */
  Row: 'row',
  /**
   * The header strip, minus the × carved out of its right end: the DRAG HANDLE.
   *
   * IT IS NOT A MEMBER OF `TalentHit`, DELIBERATELY, AND THE SPLIT WAS FORCED BY
   * THE GATE — see `TalentPanelDrag` below for the whole reason.
   */
  Header: 'header',
} as const;
export type TalentHitKind = (typeof TalentHitKind)[keyof typeof TalentHitKind];

export type TalentHit =
  | { readonly kind: typeof TalentHitKind.Close }
  | {
      readonly kind: typeof TalentHitKind.Spend;
      readonly index: number;
      readonly talentId: string;
    }
  | { readonly kind: typeof TalentHitKind.Row; readonly index: number };

/**
 * WHAT A PRESS ON THE HEADER MEANS — a second reader over the SAME geometry,
 * not a fourth branch of `TalentHit`.
 *
 * ═══ THE SPLIT IS FORCED, AND ui/inventory.ts:1270-1300 HIT IT FIRST ═══
 * A press is not a click, and this codebase has two independent proofs of it.
 * `Header` cannot join `TalentHit` because main.ts's hover block reads
 * `talentHit.kind !== TalentHitKind.Close ? talentHit.index : null` — a Header
 * variant carries no `index` and that line stops compiling, in a file this panel
 * does not own, for an outcome the hover has nothing to do with. The escape menu
 * hits the same wall one rule over: `runMenuHit`'s switch is under
 * `@typescript-eslint/switch-exhaustiveness-check` with
 * `considerDefaultExhaustiveForUnions: false`, so a sixth member is a lint error
 * there. Both files answer it the same way, which is ui/inventory.ts's answer:
 * the CLICK union keeps exactly the outcomes a click can have and stays total,
 * and the PRESS gets its own reader.
 *
 * BOTH READ THE SAME `closeRect`. There is still exactly one copy of where the
 * × is, which is the property ui/partypanel.ts:93-99 records the cost of losing.
 */
export type TalentPanelDrag = { readonly kind: typeof TalentHitKind.Header };

/**
 * The header strip's grabbable part. ONE copy of the reservation arithmetic.
 *
 * `PANEL_PAD + CLOSE_PX` is this panel's own close control, and it stays private
 * here: ui/panel.ts's `headerDragRect` deliberately does not know any panel's
 * `CLOSE_PX` (see its note), because a second authority on where a close control
 * lives is the exact duplication it exists to prevent.
 */
function headerHandle(rect: PanelRect): PanelRect {
  return headerDragRect(rect, PANEL_PAD + CLOSE_PX);
}

/**
 * WHAT A PRESS AT THIS POINT WOULD GRAB — the header, or nothing.
 *
 * THE CLOSE CONTROL IS REFUSED EXPLICITLY rather than left to `headerDragRect`'s
 * reservation, exactly as ui/inventory.ts's `inventoryPanelDragAt` refuses it:
 * pressing × and twitching two pixels must CLOSE the panel, not move it. A panel
 * narrower than its own controls gets a zero-width handle, and without this line
 * that case becomes "the close button drags the window".
 *
 * It takes no rows, because nothing above the body can move: the handle and the
 * × both depend on the panel rect alone. That is what lets a caller ask this
 * question on `mousedown` without rebuilding four talent rows per event.
 */
export function talentPanelDragAt(rect: PanelRect, px: number, py: number): TalentPanelDrag | null {
  const inside = (r: PanelRect): boolean =>
    px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
  if (inside(closeRect(rect))) return null;
  if (inside(headerHandle(rect))) return { kind: TalentHitKind.Header };
  return null;
}

/**
 * What a LOGICAL backbuffer point is over, or null.
 *
 * NULL MEANS "ON THE PANEL, BUT NOT ON ANYTHING" and never "fall through" — the
 * caller swallows the click either way, exactly as it does for the character
 * sheet. It reads the SAME geometry the painter drew with, which is the whole
 * reason `talentPanelGeometry` takes no context.
 */
export function talentPanelHitAt(
  rect: PanelRect,
  rows: readonly TalentRow[],
  px: number,
  py: number,
): TalentHit | null {
  const inside = (r: PanelRect): boolean =>
    px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;

  const geometry = talentPanelGeometry(rect, rows);
  if (inside(geometry.close)) return { kind: TalentHitKind.Close };

  for (const placed of geometry.placed) {
    if (placed.row.kind !== TalentRowKind.Talent) continue;
    // THE `+` FIRST: it sits inside the row's own rect, so testing the row first
    // would make the button unreachable while looking perfectly pressable.
    if (placed.plus !== null && inside(placed.plus)) {
      return { kind: TalentHitKind.Spend, index: placed.row.index, talentId: placed.row.id };
    }
    if (inside(placed.rect)) return { kind: TalentHitKind.Row, index: placed.row.index };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

/**
 * A talent's icon, blitted 1:1 and CENTRE-CROPPED into its box, with a traced
 * frame around it.
 *
 * NEVER SCALED — nearest-neighbour downscaling of a 64x64 ability icon is
 * exactly the resampling render/canvas.ts's backbuffer exists to prevent, and a
 * smoothed one would be the only blurred thing on the screen.
 *
 * THE FALLBACK IS A LETTER, NOT THE MISSING-ASSET BOX. It USED to be the only
 * path — the loader filtered talent icons out behind a dead `icon_ability_`
 * prefix — and it is now the CLONE path: `client/public/assets/` is gitignored
 * wholesale, so a checkout with no art has to stay playable. Four identical
 * violet error squares would make the panel unreadable, for exactly the reason
 * ui/hotbar.ts gives for its own initials.
 *
 * THE FRAME IS DRAWN EITHER WAY. TalentTrees.lua:424 draws `self.talent_frame`
 * around every node regardless of the icon, and it is what makes a row read as a
 * BUTTON rather than as a line of text with a picture next to it.
 */
function drawTalentIcon(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  icon: string,
  name: string,
  box: PanelRect,
  border: string,
): void {
  if (box.w <= 0 || box.h <= 0) return;

  ctx.fillStyle = PALETTE.VOID;
  ctx.fillRect(box.x, box.y, box.w, box.h);

  const sprite = sprites.sprite(icon);
  if (sprite !== undefined) {
    const sw = Math.min(sprite.w, box.w);
    const sh = Math.min(sprite.h, box.h);
    ctx.drawImage(
      sprite.image,
      Math.floor((sprite.w - sw) / 2),
      Math.floor((sprite.h - sh) / 2),
      sw,
      sh,
      box.x + Math.floor((box.w - sw) / 2),
      box.y + Math.floor((box.h - sh) / 2),
      sw,
      sh,
    );
  } else {
    ctx.font = FONT_ICON_FALLBACK;
    ctx.textAlign = 'center';
    ctx.fillStyle = PALETTE.SILVER;
    ctx.fillText((name.charAt(0) || '?').toUpperCase(), box.x + box.w / 2, box.y + box.h / 2);
    ctx.textAlign = 'left';
  }

  ctx.fillStyle = border;
  ctx.fillRect(box.x, box.y, box.w, 1);
  ctx.fillRect(box.x, box.y + box.h - 1, box.w, 1);
  ctx.fillRect(box.x, box.y, 1, box.h);
  ctx.fillRect(box.x + box.w - 1, box.y, 1, box.h);
}

/**
 * The selection ring a row wears: two pixels when armed, one under the pointer,
 * nothing otherwise.
 *
 * THREE DIFFERENT THICKNESSES rather than three colours, the same trick
 * ui/classpicker.ts:403-411 uses on a selected card: a shape survives greyscale
 * and the corner of an eye, and "which row is one press from spending a point
 * forever" is precisely the state that must not depend on a hue.
 */
function drawRowRing(ctx: CanvasRenderingContext2D, rect: PanelRect, thickness: number): void {
  if (thickness <= 0 || rect.w <= 0 || rect.h <= 0) return;
  ctx.fillRect(rect.x, rect.y, rect.w, thickness);
  ctx.fillRect(rect.x, rect.y + rect.h - thickness, rect.w, thickness);
  ctx.fillRect(rect.x, rect.y, thickness, rect.h);
  ctx.fillRect(rect.x + rect.w - thickness, rect.y, thickness, rect.h);
}

/** One placed row. Every fill sets its own font immediately before it. */
function drawRow(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  placed: PlacedTalentRow,
  armedId: string | null,
  hovered: number | null,
): void {
  const { row, rect } = placed;

  switch (row.kind) {
    case TalentRowKind.Points: {
      // ═══ THE COUNT IS ALWAYS DRAWN. THE PLATE IS THE EMPHASIS AND IS NOT ═══
      // LevelupDialog.lua:757-784 keeps its four counters on screen at zero;
      // :690-691 lights `glow = 0.6` only above zero. This is that split, in two
      // lines: the gold plate is upstream's glow, and the sentence underneath it
      // is upstream's counter. See `pointsText` for the full argument and for
      // what it reverses.
      const armedToSpend = row.unspent > 0;
      ctx.font = FONT_META;
      if (armedToSpend) {
        // A plate dark enough to read against whatever the panel skin is,
        // because this is the one line that says the screen has something for
        // you RIGHT NOW.
        ctx.fillStyle = PALETTE.INK;
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      }
      ctx.fillStyle = armedToSpend ? PALETTE.GOLD : PALETTE.GREY_HI;
      ctx.fillText(fitText(ctx, row.text, rect.w - 2), rect.x + 2, rect.y + rect.h / 2);
      return;
    }

    case TalentRowKind.Note: {
      ctx.font = FONT_BODY;
      ctx.fillStyle = PALETTE.GREY_HI;
      ctx.fillText(fitText(ctx, row.text, rect.w), rect.x, rect.y + rect.h / 2);
      return;
    }

    case TalentRowKind.Talent: {
      const armed = armedId === row.id;
      const atCap = row.level >= row.maxLevel;

      // The ring first, so everything else lands on top of it.
      ctx.fillStyle = armed ? PALETTE.GOLD : PALETTE.PARCHMENT;
      drawRowRing(ctx, rect, armed ? 2 : hovered === row.index ? 1 : 0);

      const box: PanelRect = { x: rect.x + 2, y: rect.y + 2, w: ICON_PX, h: ICON_PX };
      drawTalentIcon(
        ctx,
        sprites,
        row.icon,
        row.name,
        box,
        armed ? PALETTE.GOLD : row.canSpend ? PALETTE.PARCHMENT : PALETTE.SLATE,
      );

      // ═══ `n/max`, CENTRED UNDER THE ICON — TalentTrees.lua:429-433 ═══
      // The colour is LevelupDialog.lua:537-549's three-way split, mapped onto
      // this palette; the GLYPH beside it in the button slot is what makes the
      // state survive greyscale. See the header.
      ctx.font = FONT_LEVEL;
      ctx.textAlign = 'center';
      ctx.fillStyle = atCap ? PALETTE.GOLD : row.canSpend ? PALETTE.PARCHMENT : PALETTE.GREY_HI;
      ctx.fillText(
        `${row.level}/${row.maxLevel}`,
        box.x + ICON_PX / 2,
        box.y + ICON_PX + LEVEL_LABEL_H / 2,
      );
      ctx.textAlign = 'left';

      const textX = rect.x + 2 + ICON_PX + ICON_GAP;
      // The prose column stops short of the button slot, so a long talent name
      // can never be drawn underneath the `+` that buys it.
      const textW = Math.max(0, rect.x + rect.w - textX - PLUS_W - 4);

      // --- the name --------------------------------------------------------
      ctx.font = FONT_NAME;
      ctx.fillStyle = armed ? PALETTE.GOLD : PALETTE.PARCHMENT;
      ctx.fillText(fitText(ctx, row.name, textW), textX, rect.y + 8);

      // --- the current -> next diff, which is the point of the panel --------
      // Two lines rather than ToME's inline `[-> ]` because our two values are
      // whole sentences; the ARROW on the second line carries the relation.
      const wideW = Math.max(0, rect.x + rect.w - textX - 2);
      ctx.font = FONT_BODY;
      ctx.fillStyle = PALETTE.BONE;
      ctx.fillText(fitText(ctx, row.desc, wideW), textX, rect.y + 21);

      if (row.descNext !== null) {
        ctx.font = FONT_BODY;
        ctx.fillStyle = PALETTE.GOLD;
        ctx.fillText(fitText(ctx, `${ARROW} ${row.descNext}`, wideW), textX, rect.y + 33);
      }

      // --- the button slot: `+`, MAX, or nothing ---------------------------
      if (placed.plus !== null) {
        drawButton(ctx, placed.plus, armed ? PLUS_ARMED_LABEL : PLUS_LABEL, {
          ink: armed ? PALETTE.GOLD : PALETTE.PARCHMENT,
        });
      } else if (atCap) {
        // THE WORD, WHERE THE BUTTON WOULD HAVE BEEN. A capped talent and a
        // talent nobody can afford are two different facts and must not both be
        // "the button is missing".
        ctx.font = FONT_META;
        ctx.textAlign = 'right';
        ctx.fillStyle = PALETTE.GOLD;
        ctx.fillText(MAX_WORD, rect.x + rect.w - 2, rect.y + 1 + PLUS_H / 2);
        ctx.textAlign = 'left';
      }
      return;
    }
  }
}

export type TalentPanelDrawOptions = {
  readonly ctx: CanvasRenderingContext2D;
  readonly sprites: SpriteSource;
  readonly rect: PanelRect;
  /** From `talentPanelRows`. Passed in so the caller holds one copy per frame. */
  readonly rows: readonly TalentRow[];
  /** Highlights the close control, so it reads as pressable. */
  readonly hoveredClose: boolean;
  /** Loadout index under the pointer, or null. Cosmetic. */
  readonly hovered: number | null;
  /** The talent id one press from being bought, or null. See `pressSpend`. */
  readonly armedId: string | null;
  /**
   * The character level, for the header — `TALENTS · Lv 3`. See `panelTitle`.
   *
   * `ProgressMsg.level`, and NULL/absent before the first frame arrives, which
   * falls back to the bare word. OPTIONAL so the existing call site in main.ts
   * compiles unchanged; a caller that omits it gets the title this panel had
   * before, which is a degradation nobody can misread.
   */
  readonly level?: number | null;
};

/**
 * Paint the panel.
 *
 * `save`/`restore` around everything because it sets `font`, `textAlign`,
 * `textBaseline` and `fillStyle`, none of which the world painter re-sets before
 * every call — a leak surfaces three milestones later as a mysteriously
 * right-aligned label somewhere else entirely. CLIPPED to its own rect for the
 * reason the card strip, the party pane and the sheet are: a long description
 * must never bleed onto the map.
 *
 * IT DRAWS NO SCRIM. That is not an omission — it is the panel-not-modal
 * decision made visible. Everything behind it is still live and still pressable.
 */
export function drawTalentPanel(options: TalentPanelDrawOptions): void {
  const { ctx, sprites, rect, rows, hoveredClose, hovered, armedId } = options;
  if (rect.w <= 0 || rect.h <= 0) return;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  drawPanel(ctx, sprites, PanelSkin.CaseFile, rect);
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();

  drawHeader(ctx, sprites, panelTitle(options.level), rect, FONT_META);

  const geometry = talentPanelGeometry(rect, rows);
  for (const placed of geometry.placed) drawRow(ctx, sprites, placed, armedId, hovered);

  // ONE SENTENCE ABOUT THE PRESS, and only while something is armed. A permanent
  // legend would be furniture; this is the moment the warning is worth reading,
  // and it is drawn last so it sits over whatever row it is about.
  if (armedId !== null) {
    const y = rect.y + rect.h - INSET - NOTE_ROW_H;
    ctx.font = FONT_META;
    ctx.fillStyle = PALETTE.INK;
    ctx.fillRect(rect.x + INSET, y, Math.max(0, rect.w - INSET * 2), NOTE_ROW_H);
    ctx.fillStyle = PALETTE.ORANGE;
    ctx.fillText(
      fitText(ctx, 'press + again to spend — there is no refund', Math.max(0, rect.w - INSET * 2)),
      rect.x + INSET,
      y + NOTE_ROW_H / 2,
    );
  }

  // The close control. The key that opened the panel closes it too and always
  // will — this is the mouse's copy of the same act.
  drawButton(ctx, geometry.close, '×', {
    ink: hoveredClose ? PALETTE.GOLD : PALETTE.GREY_HI,
  });

  ctx.restore();
}

/**
 * The panel's minimum height, for callers that need to reason about whether one
 * will fit before they ask for a rect. Exported for the test that pins the
 * bottom of the size range; nothing in production reads it.
 */
export const TALENT_PANEL_MIN_H = PANEL_MIN_H;
/** As above, for the width. */
export const TALENT_PANEL_MIN_W = PANEL_MIN_W;
/** The air the panel leaves around itself inside its band. */
export const TALENT_PANEL_MARGIN = PANEL_MARGIN;
