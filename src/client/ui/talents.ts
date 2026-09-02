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

import type { HoverCard } from './panel.ts';
import { PALETTE } from '../render/canvas.ts';
import {
  drawButton,
  drawHeader,
  drawPanel,
  fitText,
  wrapText,
  headerDragRect,
  HEADER_H,
  PANEL_PAD,
  PanelSkin,
} from './panel.ts';
import {
  CATEGORY_POINT_LEVELS,
  MASTERY_STEP,
  canRaiseStat,
  isGenericTree,
} from '../../shared/progression.ts';
import type { LoadoutTalent, ProgressMsg, UnlockableTree } from '../../shared/protocol.ts';
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
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GRID'S MEASUREMENTS. 32, NOT 24, AND THE EXTRA EIGHT PIXELS ARE THE POINT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A category strip is a header, a row of five icons, and a rank under each. At
 * 32 with a 4-pixel gap five icons are 176 wide, so TWO CATEGORIES FIT SIDE BY
 * SIDE inside this panel with room to spare — which is what the player's
 * screenshot shows and what turns a scrolling list into a screen you read at a
 * glance.
 *
 * The old layout gave each talent a 43-pixel full-width row; five of them
 * overflowed. A strip is 63 pixels and holds five. That is the whole arithmetic
 * behind the redesign.
 */
const ICON_PX = 32;
/** Between two icons in a strip. */
const CELL_GAP = 4;
/** The rank caption under an icon — "4/5". */
const RANK_H = 11;
/** The category heading above the icons. */
const CAT_HEAD_H = 13;
/** Air under a strip, before the next one. */
const CAT_PAD = 7;
/** One whole category block. */
const CAT_H = CAT_HEAD_H + ICON_PX + RANK_H + CAT_PAD;

/**
 * ONE STRIP PER WHEEL NOTCH.
 *
 * ═══ PIXELS, AND THE UNIT IS THE POINT ═══
 * The only other scrolling surface in this client is the Case Log, and it scrolls
 * by ENTRY INDEX — its `SCROLL_STEP` is a count of log lines. Reaching for that
 * constant here would compile and would move the grid by four pixels a notch,
 * because the two numbers share a name and mean different things.
 *
 * A strip is the natural unit for this grid: one notch, one row of disciplines,
 * so a player always lands on a whole row rather than halfway through icons they
 * are about to click.
 */
export const TALENT_SCROLL_STEP = CAT_H;

/**
 * THE SCROLLBAR, DRAWN RATHER THAN BLITTED.
 *
 * There is no scrollbar sprite in the manifest and there will not be one — the
 * art is the player's to replace and a bar is not art, it is furniture. Four
 * pixels of `SLATE` with a `GREY_HI` thumb reads at 32px tiles without asking
 * anyone to draw anything.
 */
const BAR_W = 4;
const BAR_GAP = 3;
/** A thumb shorter than this stops looking like a control. */
const BAR_MIN_THUMB = 8;
/** Between the two columns of categories. */
const COL_GAP = 14;
/**
 * How many icons a strip is sized for.
 *
 * ═══ FIVE, THEN SIX, AND THE GRID DOES NOT DISCOVER THIS FOR ITSELF ═══
 * ToME's categories hold five and this held five to match. The strip is drawn by
 * SLICING — `row.talents[n]` for n < this number — so a category with more than
 * this many talents loses the extras SILENTLY: they type-check, register, reach
 * the wire and cost a point to buy, and never appear.
 *
 * `test/server/talent-trees.test.ts` asserts every tree holds exactly this many
 * for that reason, and it is what caught the sixth active landing in each tree.
 * Six columns is 212 pixels, so two of them plus `COL_GAP` and the insets is 454
 * against a `PANEL_W` of 480 — it fits, and a seventh would not.
 */
const CELLS_PER_CAT = 6;
/** One column of categories. */
const COL_W = CELLS_PER_CAT * ICON_PX + (CELLS_PER_CAT - 1) * CELL_GAP;

const LEVEL_LABEL_H = 11;

/** Air between the icon column and the prose column. */

/** One talent row: the icon stack on the left, three lines of prose on the right. */
const TALENT_ROW_H = ICON_PX + LEVEL_LABEL_H + 8;
/** The points badge, and the note that replaces a dropped row. */
const POINTS_ROW_H = 14;
/** A tree's heading and the hairline under it. */
const NOTE_ROW_H = 12;

/** The `+` control. Square-ish, so it is a target rather than a glyph. */

/** The close control, top-right of the header strip. Square, so it is a target. */
const CLOSE_PX = 13;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PREFERRED AND MINIMUM SIZE — AND 320 WAS TOO NARROW TO SAY ANYTHING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A player photographed this panel with every description cut off mid-sentence:
 * *"Loose a flare at a target up to 5 tiles away for…"*. The prose column at 320
 * is about 250 pixels, which is forty monospace characters, and a talent
 * description is sixty to ninety — so the panel whose entire subject is WHAT A
 * TALENT DOES was showing less than half of every sentence, on both the current
 * line and the next-rank line under it.
 *
 * WIDER *AND* WRAPPED, because widening alone only moves the cut. 480 still
 * fits the guaranteed floor with room (`HUD_MIN_W` is 640 logical pixels, and
 * this needs 480 + 12 of margin), and the height grows with
 * the text rather than the text being trimmed to the height.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DESCRIPTION COLUMN — WHAT THE SCREENSHOT ASKED FOR, AND WHY IT IS WIDTH.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ToME's levelup dialog is two things side by side: the trees on the left, and
 * everything about ONE talent down the right — its name, its current level and
 * what the next one would be, its mode, cost, range, cooldown, and the sentence
 * saying what it does with the next rank's numbers written in beside the
 * current ones. The player sent that screen and asked for it.
 *
 * ═══ THIS IS NOT THE STRIP THAT WAS REMOVED ═══
 * An earlier version reserved a strip at the FOOT of the panel and it was
 * replaced by a hover card, on the stated grounds that "a reserved strip costs
 * its height on every frame whether or not anything is being pointed at". That
 * argument was about HEIGHT and it still holds — the grid keeps the whole band.
 * A column costs WIDTH, which this panel has to spare on any window wide enough
 * to be given one, and which the grid cannot use anyway: it packs into two
 * fixed columns and a third will not fit.
 *
 * ═══ AND IT IS CONDITIONAL, SO THE FLOOR STILL WORKS ═══
 * `HUD_MIN_W` is 640 logical pixels and a 760-wide panel does not fit in it. Below the threshold the panel is exactly what it was and
 * the hover card is still the answer, which is the honest degradation: a
 * description squeezed into 90 pixels would be the cut-off-mid-sentence bug the
 * width above this was widened to fix.
 */
/**
 * 266, and the two pixels it was haggled over no longer decide anything.
 *
 * This note read: *"266 AND NOT 268 ... at 268 the threshold lands on 774, which
 * puts 772x480, a size this client's own viewport table tests at, two pixels the
 * wrong side of having a description column."* That was a real measurement of a
 * threshold made of THIS number. The threshold is `DETAIL_MIN_PANEL_W` now, so
 * the width of the column and the window that earns one are separate decisions —
 * which is why 772x480 lands firmly on the no-column side rather than by two
 * pixels, and why changing this number cannot move a threshold again.
 */
const DETAIL_W = 266;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW WIDE THE PANEL MUST BE BEFORE IT SPENDS 266 PIXELS ON PROSE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ported verbatim from LevelupDialog.lua:90 — `if game.w * 0.9 >= 1000 then
 * self.no_tooltip = true end`. Upstream's dialog IS `game.w * 0.9`, which is
 * what `talentPanelRect` computes, so the comparison is the same one: a
 * thousand pixels of PANEL, not of window.
 *
 * Below it upstream keeps the floating tooltip and gives the list every pixel.
 * So do we — `talentTipAt` is that tooltip and it answers the same question.
 */
const DETAIL_MIN_PANEL_W = 1000;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ATTRIBUTE COLUMN — ToME'S LEVELUP DIALOG PUTS THE STATS DOWN THE LEFT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Six rows: the name, the value, and a `+` while there is a point in hand. The
 * player sent that screen and asked for the attribute points on this page.
 *
 * ═══ TEXT AND NOT ICONS, AND THAT IS AN ART CONSTRAINT STATED OUT LOUD ═══
 * Upstream draws a portrait strip of six stat icons. There are no stat icons in
 * this manifest and inventing keys for them would paint the pink missing-asset
 * square six times down the side of the screen — the same trap `drawTalentIcon`
 * documents. Names are also better at this size: `STR 25` is unambiguous where a
 * 12-pixel glyph of a fist is a guess.
 *
 * ═══ 78 PIXELS, MEASURED RATHER THAN GUESSED ═══
 * The widest row is `CON 100 +` — nine characters of the 10px monospace at six
 * pixels each is 54, plus the `+` hit box and the padding either side. It is
 * deliberately the NARROWEST of the three columns because it is the one whose
 * content cannot grow: there are exactly six stats and the values are bounded at
 * 100 by `load.lua:182-189`.
 */
const STATS_W = 78;

const PANEL_W = 480;
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE WIDTHS, AND THE ORDER THEY ARE EARNED IN IS A JUDGEMENT ABOUT NEED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The grid is the screen. The attribute column comes next, and the description
 * column last — which INVERTS the order they landed in, and the reason is that
 * one of them has an alternative and the other does not:
 *
 *   SPENDING A POINT IS A REQUIRED ACTION with no other route. There is no
 *   command, no key and no other panel; if the column is not drawn, a levelled
 *   character simply cannot spend what they were granted.
 *
 *   READING A DESCRIPTION HAS A WORKING ALTERNATIVE — the hover card, which is
 *   what this panel used for its whole life before the column existed and what
 *   it still falls back to below the threshold.
 *
 * So a 772-wide window trades the description it had yesterday for the ability
 * to spend attribute points, and gets the card back in exchange. That is the
 * right way round; the other way leaves a player looking at a `Stats: 3` they
 * cannot act on.
 */
const PANEL_W_STATS = PANEL_W + COL_GAP + STATS_W;
/** All three columns. See `DETAIL_W` and `STATS_W`. */
const PANEL_W_WIDE = PANEL_W_STATS + COL_GAP + DETAIL_W;
const PANEL_MIN_W = 176;
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW TALL THE TALENT WINDOW MAY GET — ToME's share, not a pixel ceiling.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ported from t-engine4 game/modules/tome/dialogs/LevelupDialog.lua:89:
 *
 *     Dialog.init(self, "Levelup: "..actor.name,
 *       game.w * 0.9, game.h * 0.9, game.w * 0.05, game.h * 0.05)
 *
 * ═══ IT WAS A FLAT 300 PIXELS, AND THAT HID TALENT TREES ═══
 * The grid drops whole CATEGORIES when it runs out of vertical room and prints
 * "N categories hidden — panel too small" (see the note row below). On a
 * 769-pixel window the panel took 300 of them — under two fifths — so a
 * character with a full complement of trees could not see them all, on a screen
 * with room for every one twice over. Reported as "the talent (G) is too small
 * to accomodate and the page says so".
 *
 * THE FLOOR STAYS. `PANEL_MIN_H` still guards the tiny end, and the band clamp
 * below still means the panel can never be drawn taller than the space between
 * the HUD docks.
 */
const PANEL_MAX_FILL_H = 0.9;
/** The shortest useful window, below which the panel refuses rather than lies. */
const PANEL_ABS_MIN_H = 160;
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
/** The word half of the a-point-is-available signal. */
/** The `+` once it is armed. A different GLYPH, not merely a different colour. */

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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ONE WHOLE CATEGORY — the header and the row of icons under it.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This is the unit ToME's talent screen is built from, and the player sent a
   * screenshot of it: "Technique / Two-handed assault (x1.10)" over a horizontal
   * strip of five icons, each with "4/5" beneath.
   *
   * IT REPLACED ONE ROW PER TALENT, and the swap is what made the screen fit.
   * The old layout gave every talent a full-width row carrying its icon, its
   * name, its description AND its next-rank line — forty-three pixels each, so
   * five talents overflowed the panel and the drop policy started hiding them.
   * A category strip is sixty-three pixels and holds FIVE. The descriptions did
   * not disappear; they moved to `Detail`, which is exactly the trade upstream
   * makes and the reason its screen shows twenty-five talents at once.
   */
  Category: 'category',
  /**
   * THE ONE TALENT THE PLAYER IS POINTING AT.
   *
   * NOT A STRIP AT THE FOOT OF THE PANEL — a HOVER CARD over it, which is what
   * was asked for and is what ToME does. A reserved strip costs its height on
   * every frame whether or not anything is being pointed at; a card costs
   * nothing until the pointer stops, and the height it does not take becomes
   * another row of categories. This row kind survives only as the CONTENT of
   * that card, resolved by `talentTipAt` and drawn by the caller on top.
   */
  Detail: 'detail',
  /** A sentence about the panel itself — what was dropped, or that nothing came. */
  Note: 'note',
} as const;
export type TalentRowKind = (typeof TalentRowKind)[keyof typeof TalentRowKind];

/**
 * ONE ICON IN A CATEGORY STRIP — everything the grid needs about a talent.
 *
 * A projection of `LoadoutTalent` rather than the frame itself, because the grid
 * asks four questions of a talent (what is it, what rank, can I buy it, is it
 * pressable) and carrying the whole wire type would invite a painter to reach
 * for a field the geometry never measured.
 */
export type TalentCell = {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly level: number;
  readonly maxLevel: number;
  /**
   * True when a point is in hand, the talent is below its cap, AND the tier
   * ladder will let the next rank through.
   *
   * THE THIRD CLAUSE IS NEW AND IT IS THE ONE THAT BITES. Every talent in the
   * game now declares a tier and a stat gate; before that, `checkTier` said
   * yes to everything and `level < maxLevel` really was the whole rule.
   */
  readonly canSpend: boolean;
  /**
   * MAY THIS RANK BE TAKEN BACK RIGHT NOW? The server's answer, carried whole.
   *
   * NOT COMPUTED HERE, and it could not be: the rule turns on the ORDER ranks
   * were bought in (the last four class / three generic spends) and on what
   * kind of realm the body is standing in, and the client has neither fact. A
   * panel that guessed would draw a `-` the server then refuses, which reads as
   * a broken button rather than as a rule. See `LoadoutTalent.unlearnable`.
   */
  readonly canUnlearn: boolean;
  /**
   * WHY THE NEXT POINT CANNOT GO HERE, in the server's own words — or null.
   *
   * ═══ A GREY BUTTON WITHOUT THIS IS WORSE THAN A LIVE ONE ═══
   * "Learn 2 more of this discipline first." is a decision a player can act on
   * this second. An icon that is simply dimmer than its neighbours, with a
   * point in hand and nothing said, reads as the panel being broken — and the
   * player's next move is to press it again, and then to stop trusting the
   * screen. `tierRefusalText` renders it once, server-side, so this sentence
   * and the one a refused `spend_point` would carry are the same string.
   */
  readonly lockedReason: string | null;
  /**
   * EVERY REQUIREMENT OF THE NEXT RANK, met or not — `LoadoutTalent.requires`.
   *
   * `lockedReason` above is a REFUSAL and exists only while one applies. This is
   * a FACT about the talent and is here whether or not the point can be spent,
   * which is the whole difference: without it a player learned a requirement by
   * being stopped at it, three points into a tree they had already committed to.
   *
   * Empty for a talent at its cap, and for a server too old to send them.
   */
  readonly requires: readonly { readonly text: string; readonly met: boolean }[];
  /**
   * THE TREE THIS CELL WOULD UNLOCK, or null for one the character already owns.
   *
   * PRESENT IS WHAT MAKES A PRESS AN UNLOCK. A cell in a locked tree does not
   * spend a talent point on itself — it spends a CATEGORY point on the whole
   * discipline — and `pressSpend`'s caller reads this to decide which frame to
   * send. Storing the tree id rather than a boolean is what lets it send one.
   */
  readonly unlocks: string | null;
  /** A passive is drawn without the pressable furniture. See `TalentKind`. */
  readonly passive: boolean;
  /** What it does now, and one point from now. Shown in the detail strip. */
  readonly desc: string;
  readonly descNext: string | null;
  /** Cost and reach, for the detail strip's meta line. */
  readonly cost: LoadoutTalent['cost'];
  readonly cooldownTurns: number;
  readonly range: number;
};

export type TalentRow =
  | {
      /** A category: its heading, and every talent in it. */
      readonly kind: typeof TalentRowKind.Category;
      /** The tree id, so a hit can name which category was pressed. */
      readonly tree: string;
      /** "Discipline", or "Discipline  (x1.30)" when the mastery is not 1. */
      readonly text: string;
      /**
       * A CATEGORY POINT IS IN HAND AND THIS TREE HAS NOT BEEN DEEPENED YET —
       * LevelupDialog.lua:433-437's `else` branch, offered.
       *
       * FALSE ON EVERY LOCKED TREE, whose whole strip already spends the same
       * point on the same message; two live offers in one category would make
       * "which one did I just buy" unanswerable at the moment of no return.
       */
      readonly deepen: boolean;
      /** In the class table's order. `talentPanelRows` never re-sorts. */
      readonly talents: readonly TalentCell[];
    }
  | {
      /** The talent under the pointer, drawn in full at the foot of the panel. */
      readonly kind: typeof TalentRowKind.Detail;
      readonly cell: TalentCell | null;
    }
  | {
      readonly kind: typeof TalentRowKind.Points;
      /** Points in hand. ZERO IS A VALID VALUE and draws the second or third state. */
      readonly unspent: number;
      /** The whole sentence, composed by `pointsText`. One copy, read by the painter. */
      readonly text: string;
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
  /**
   * The passives. A separate array all the way from `ClassDef.passives` — see
   * `LoadoutMsg.passives`. The panel lists them; the hotbar never sees them.
   */
  readonly passives?: readonly LoadoutTalent[];
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE DISCIPLINES THIS CHARACTER COULD BUY AND HAS NOT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Drawn AFTER everything they own, as ordinary categories with an ordinary
   * strip of icons — because a category point is the scarcest currency in the
   * game and asking a player to spend one on a name they have never seen the
   * inside of is the same failure as a talent with no description.
   *
   * The talents in here are at rank 0 and are not a preview in the
   * placeholder sense: rank 0 is exactly what the character would hold on the
   * day they bought the tree.
   */
  readonly unlockable?: readonly UnlockableTree[];
  /**
   * Tree ids this character knows and could deepen — `LoadoutMsg.deepenable`.
   *
   * IDS ONLY, because the category is already on this panel: the offer is drawn
   * INTO the header it belongs to rather than as a second copy of the tree.
   */
  readonly deepenable?: readonly string[];
  /**
   * Category points in hand. They arrive at the levels `CATEGORY_POINT_LEVELS`
   * names — three of them in a career, which is what makes buying one a choice.
   *
   * ABSENT FROM AN OLDER SERVER, which reads as none — so the panel offers no
   * unlock rather than offering one that would be refused.
   */
  readonly categories?: number;
  /**
   * WHICH TALENT THE DETAIL STRIP IS ABOUT — hovered, or armed, or neither.
   *
   * Resolved by the caller because only the caller knows where the pointer is.
   * The strip is reserved whether or not this is set: one that appeared on hover
   * would move every category under the cursor, so the panel would flinch away
   * from the mouse.
   */
  readonly focusId?: string | null;
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
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW MANY POINTS ARE WAITING, OF ANY KIND — the number every nag counts.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Four purses reach this panel: class talents, generic talents, whole
 * disciplines, and attributes. Every affordance that points a player AT the
 * panel used to count only the first — the escape menu's `TALENTS (2)`, the
 * character sheet's `[G·2]`, the status line's "press g" nag and the level-up
 * toast — so a level that granted 2 generics and 3 attribute points and no class
 * point said nothing at all, on all four, while five points sat in hand.
 *
 * Generic points arrive four levels out of five and attribute points arrive
 * every level, so THAT WAS THE ORDINARY CASE rather than an edge.
 *
 * Upstream's own plate tests all four and says so in one expression —
 * `player.unused_stats > 0 or player.unused_talents > 0 or player.unused_generics
 * > 0 or player.unused_talents_types > 0` (Minimalist.lua:1512).
 *
 * ONE FUNCTION, so the four affordances cannot drift apart again, and so a fifth
 * purse is one edit rather than five.
 */
export function pointsWaiting(progress: ProgressMsg | null): number {
  if (progress === null) return 0;
  // `?? 0` ON THE OPTIONAL THREE: a server too old to send a purse must read as
  // an empty one, never as NaN — see `ProgressMsg`, where only `unspent` is
  // required.
  return (
    Math.max(0, Math.floor(progress.unspent)) +
    Math.max(0, Math.floor(progress.unspentGenerics ?? 0)) +
    Math.max(0, Math.floor(progress.unspentCategories ?? 0)) +
    Math.max(0, Math.floor(progress.unspentStats ?? 0))
  );
}

function pointsText(progress: ProgressMsg): string {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * EVERY PURSE, NAMED. This used to say only `unspent`, AND THAT WAS A BUG.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * There are three purses and they are not interchangeable: `unspent` buys
   * class talents, `unspentGenerics` buys `generic/` ones, `unspentCategories`
   * buys whole disciplines. The server has kept them apart since they existed
   * (gateway.ts:11582's `fromGenerics ? body.unspentGenerics : body.unspentPoints`)
   * and sends all three; this row read one of them.
   *
   * ═══ WHAT THAT LOOKED LIKE, AT NEARLY EVERY LEVEL-UP ═══
   * Generic points arrive four levels out of five. So the ordinary state was
   * class 0, generic 2 — and the panel said **"no points — next at level N"**
   * over a screen of generic icons that were live, affordable and, because
   * `canSpend` read the same one number, unpressable. A player was told they had
   * nothing while holding two points they could have spent.
   *
   * Upstream shows the counters side by side and always — `Stats`, `Class
   * points`, `Generic points`, `Category points` (LevelupDialog.lua:754-789),
   * each glowing above zero. This is one row rather than four, so it names the
   * ones that have something in them and falls back to the level sentence only
   * when every purse is empty.
   */
  const purses: string[] = [];
  if (progress.unspent > 0) purses.push(`${String(progress.unspent)} class`);
  if (progress.unspentGenerics > 0) purses.push(`${String(progress.unspentGenerics)} generic`);
  // OPTIONAL ON THE WIRE, unlike the two above — a server that predates category
  // points sends nothing, and nothing must read as none rather than as NaN.
  const categories = progress.unspentCategories ?? 0;
  if (categories > 0) {
    purses.push(categories === 1 ? '1 category' : `${String(categories)} category`);
  }
  // AND ATTRIBUTES, which are spent on this same screen (the column on the
  // right) and were named nowhere else in the client — `unspentStats` reached
  // exactly one call site, inside a column that a narrow panel drops entirely.
  const stats = progress.unspentStats ?? 0;
  if (stats > 0) purses.push(`${String(stats)} stat`);
  if (purses.length > 0) {
    // "2 class · 1 generic to spend". The middot rather than a comma because
    // these are three separate quantities and not a list of one thing.
    return `${purses.join(' · ')} to spend`;
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
  const generics = progress?.unspentGenerics ?? 0;
  if (progress !== null) {
    /**
     * THE PLATE COUNTS BOTH SPENDABLE PURSES. `unspent` alone left the "you have
     * points" highlight dark on a level-up that granted only generics, which is
     * four level-ups in five. Categories are deliberately NOT added: they are
     * spent on the locked rows at the foot of the panel, which carry their own
     * price, and a plate that lit for them would point at the talents above.
     */
    rows.push({
      kind: TalentRowKind.Points,
      unspent: unspent + generics,
      text: pointsText(progress),
    });
  }

  /**
   * THE FOUR AND THE PASSIVES, IN ONE LIST — but only here, and only to read.
   * `LoadoutMsg` keeps them apart so the hotbar cannot show a talent with
   * nothing to press; the PANEL is the surface where they are all just talents
   * the player owns and can raise, which is what ToME's tree view is.
   */
  const shown = [...view.loadout, ...(view.passives ?? [])];

  if (shown.length === 0) {
    // NEVER A BLANK BOX. `loadout` is unicast in the `hello` block, so this is a
    // one-frame window on connect — but an empty panel in that window is
    // indistinguishable from a broken one, and the player's next move is to
    // press the key again.
    rows.push({ kind: TalentRowKind.Note, text: 'waiting for your loadout…' });
    return rows;
  }

  const cellOf = (talent: LoadoutTalent): TalentCell => ({
    id: talent.id,
    name: talent.name,
    icon: talent.icon,
    level: talent.level,
    maxLevel: talent.maxLevel,
    // `=== true` RATHER THAN TRUTHINESS: the field is optional on the wire, and
    // an older server that has never heard of tiers sends nothing at all. That
    // must read as "not locked" — the behaviour this panel has always had —
    // rather than as a lock nobody can explain.
    /**
     * THE PURSE IS CHOSEN BY THE TREE, exactly as the server chooses it
     * (`isGenericTree` at gateway.ts:11582). Reading `unspent` for everything
     * made every generic icon unpressable whenever the class purse was empty —
     * and, the other way round, advertised a live `+` on a generic icon the
     * server would refuse with "no generic points in hand".
     *
     * A TALENT WITH NO `tree` (a server too old to send one) falls to the class
     * purse, which is the behaviour this panel has always had.
     */
    canSpend:
      (isGenericTree(talent.tree ?? '') ? generics : unspent) > 0 &&
      talent.level < talent.maxLevel &&
      talent.locked !== true,
    // ABSENT MEANS NO, which is what every client believed before the field
    // existed and is why the server may omit it.
    canUnlearn: talent.unlearnable === true,
    lockedReason: talent.locked === true ? (talent.lockedReason ?? 'Not yet.') : null,
    // `?? []` — absent means a server that does not send them, and the pane then
    // shows exactly what it showed before this existed.
    requires: talent.requires ?? [],
    passive: talent.kind === 'passive',
    desc: talent.desc,
    descNext: talent.descNext,
    cost: talent.cost,
    cooldownTurns: talent.cooldownTurns,
    range: talent.range,
    // OWNED, so nothing here unlocks anything. The locked half builds its own
    // cells below.
    unlocks: null,
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * GROUPED BY TREE, IN FIRST-APPEARANCE ORDER. NEVER SORTED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The loadout arrives in the class table's order, which already groups a
   * tree's talents together — so first appearance IS the authored order, and
   * sorting here would be a second opinion about a sequence the content states.
   *
   * A LOADOUT FROM A SERVER TOO OLD TO SEND `tree` produces ONE category with an
   * empty heading, which draws as the flat strip this panel had before trees
   * existed. That is the additive-field contract holding: an old server loses
   * the grouping, never the talents.
   */
  const order: string[] = [];
  /**
   * WHICH KNOWN TREES THE SERVER SAYS ARE STILL DEEPENABLE, and the purse.
   *
   * BOTH CLAUSES, because the list answers "has this been deepened" and only the
   * purse answers "can you afford it". Offering one with no point in hand would
   * be a live control the server refuses, which `TalentCell.canUnlearn` records
   * as reading like a broken button rather than a rule.
   */
  const deepenOffer =
    (view.categories ?? 0) > 0 ? new Set(view.deepenable ?? []) : new Set<string>();
  const byTree = new Map<string, { text: string; deepen: boolean; cells: TalentCell[] }>();
  for (const talent of shown) {
    const key = talent.tree ?? '';
    let group = byTree.get(key);
    if (group === undefined) {
      const mastery = talent.mastery ?? 1;
      const heading = talent.treeName ?? talent.tree ?? '';
      group = {
        // "Discipline  (x1.30)" — upstream's own header shape. ONE POINT OH IS
        // LEFT UNSAID: printing "(x1.00)" on every category would be furniture
        // teaching a player to stop reading the number that matters.
        /**
         * AND WHICH PURSE IT SPENDS FROM. Upstream marks every node `(generic)`
         * or `(class)` (LevelupDialog.lua:583) and puts the two in physically
         * separate columns (:812-836); ours mixes both kinds into one flow grid,
         * so without the mark there is nothing on screen that says why one strip
         * is live and the one under it is grey.
         *
         * ONLY GENERIC IS MARKED. Class trees are the majority and the default,
         * and labelling every one of them `(class)` is the furniture the mastery
         * line above already refuses to print.
         */
        text: `${mastery === 1 ? heading : `${heading}  (x${mastery.toFixed(2)})`}${
          isGenericTree(key) ? '  — generic' : ''
        }${
          /**
           * AND THE OFFER, ON THE HEADER, because the thing bought is the
           * CATEGORY and not any talent in it. Upstream puts the +/- on the
           * category row for the same reason (LevelupDialog.lua:433).
           *
           * IT NAMES THE NEW NUMBER rather than the step. "+0.2" is arithmetic
           * a player has to do while deciding whether to spend the scarcest
           * currency in the game; "→ x1.20" is the answer to it.
           */
          deepenOffer.has(key) ? `  — deepen to x${(mastery + MASTERY_STEP).toFixed(2)}` : ''
        }`,
        deepen: deepenOffer.has(key),
        cells: [],
      };
      byTree.set(key, group);
      order.push(key);
    }
    group.cells.push(cellOf(talent));
  }

  for (const key of order) {
    const group = byTree.get(key);
    if (group === undefined) continue;
    rows.push({
      kind: TalentRowKind.Category,
      tree: key,
      text: group.text,
      deepen: group.deepen,
      talents: group.cells,
    });
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND THE DISCIPLINES THERE ARE LEFT TO BUY, UNDERNEATH EVERYTHING OWNED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * LAST, ALWAYS. What a player owns is what they came to this panel for; a
   * locked tree sitting above their own would be an advertisement in front of
   * the thing it interrupts.
   *
   * THE HEADING CARRIES THE PRICE, and it changes with the purse. "1 category
   * point" when they can afford it, and the levels `CATEGORY_POINT_LEVELS`
   * names when they cannot —
   * because "locked" alone tells a player nothing they can act on, and the
   * second sentence is the whole answer to "so how do I get it".
   */
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHEN THE POINTS ARRIVE, READ OFF THE LIST THAT DECIDES IT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This sentence was the literal "levels 10, 20 and 36", written out FOUR TIMES
   * in this file — twice in a row a player reads and twice in a hover card. The
   * levels live in `CATEGORY_POINT_LEVELS` (shared/progression.ts), which is
   * where `categoryPointsForLevel` reads them, so moving one would have left four
   * player-facing strings quietly lying about when their next discipline unlocks.
   *
   * The same shape of drift this codebase has now been caught by three times:
   * `status-live.mjs` naming "the three registered ids" when there were six, a
   * test asserting three classes when a fourth shipped, and the inventory doll
   * budgeting against a 480-pixel floor that is 320.
   */
  const pointLevels = (): string => {
    const levels = [...CATEGORY_POINT_LEVELS];
    const last = levels.pop();
    if (last === undefined) return 'never';
    // "10, 20 and 36" — an Oxford-less list, because it is prose in a panel
    // rather than a spec, and a one-element list must not read "and 10".
    return levels.length === 0 ? String(last) : `${levels.join(', ')} and ${String(last)}`;
  };

  const purse = view.categories ?? 0;
  for (const tree of view.unlockable ?? []) {
    rows.push({
      kind: TalentRowKind.Category,
      tree: tree.id,
      // A LOCKED TREE IS NOT DEEPENABLE. Its every icon already spends the
      // category point on the same `unlock_tree` message.
      deepen: false,
      text:
        purse > 0
          ? `${tree.name}  — locked, 1 category point`
          : `${tree.name}  — locked, points arrive at levels ${pointLevels()}`,
      talents: tree.talents.map((talent) => ({
        id: talent.id,
        name: talent.name,
        icon: talent.icon,
        level: talent.level,
        maxLevel: talent.maxLevel,
        // AFFORDABLE MEANS THE TREE, NOT THE TALENT. Pressing any icon in a
        // locked discipline buys the DISCIPLINE — see `TalentCell.unlocks` —
        // so the `+` is live exactly when a category point is in hand, whatever
        // the talent's own rank or tier would say.
        canSpend: purse > 0,
        // A LOCKED TREE HAS NOTHING TO TAKE BACK. Its ranks were never bought,
        // so no spend of theirs is in the ledger and the server would refuse.
        canUnlearn: false,
        /**
         * NO REQUIREMENT LIST ON A TREE YOU DO NOT OWN. The only thing standing
         * between the player and these icons is the DISCIPLINE — a category
         * point — and listing a talent's stat and level gates underneath that
         * would offer four things to fix when exactly one of them is the answer.
         * They appear the moment the tree is bought, which is when they start
         * being actionable.
         */
        requires: [],
        lockedReason:
          purse > 0
            ? `Unlock ${tree.name} — 1 category point. ${tree.blurb}`
            : `${tree.name} is locked. Category points arrive at levels ${pointLevels()}.`,
        passive: talent.kind === 'passive',
        desc: talent.desc,
        descNext: talent.descNext,
        cost: talent.cost,
        cooldownTurns: talent.cooldownTurns,
        range: talent.range,
        unlocks: tree.id,
      })),
    });
  }

  return rows;
}

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

  // THE WIDE SHAPE WHEN IT FITS WHOLE, never a squeezed one: `Math.min` against
  // the wide width would hand back every intermediate size between the two, and
  // the description column would be born narrow on exactly the windows it is
  // least useful on. Two sizes, and the threshold is "does the whole thing fit".
  // WHOLE SHAPES ONLY, never an intermediate one: `Math.min` against a wide
  // width hands back every size between the tiers, and a column born narrow is a
  // column that is useless on exactly the windows it is least useful on.
  const room = width - PANEL_MARGIN * 2;
  const tier =
    room >= PANEL_W_WIDE
      ? PANEL_W_WIDE
      : room >= PANEL_W_STATS
        ? PANEL_W_STATS
        : Math.min(PANEL_W, room);
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE TIER IS A FLOOR, NOT A CEILING — LevelupDialog.lua:89's `game.w * 0.9`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The tiers above decide WHICH COLUMNS APPEAR: the stats strip needs room, the
   * description pane needs more, and a column born narrow is useless on exactly
   * the windows it is least useful on. That argument is intact and is why the
   * tier is still computed and still the minimum.
   *
   * ═══ WHAT IT MUST NOT DO IS CAP THE PANEL ═══
   * Taking the tier as the final width meant the panel was 572 wide on a
   * 772-pixel viewport — TWO HUNDRED PIXELS UNUSED — while the category grid ran
   * out of vertical room and dropped whole talent trees with a row saying so.
   * At 1280 it was 852 against 428 spare. The panel was refusing width it had
   * while telling the player it was too small.
   *
   * Upstream takes nine tenths of the screen. The tier stays as the floor, so a
   * window too narrow for the description pane still gets the whole shape it can
   * hold, and a window with room to spare gets more grid columns instead of
   * whitespace.
   */
  const w = Math.max(tier, Math.min(Math.floor(width * PANEL_MAX_FILL_H), room));
  /**
   * AGAINST THE WHOLE WINDOW, THEN FITTED TO THE BAND — LevelupDialog.lua:89
   * measures `game.h`, the entire screen, and the band is already that screen
   * minus the HUD docks. Taking the share of the BAND instead would count them
   * twice and hand back a shorter panel than the flat 300 it replaced.
   */
  const wantedH = Math.max(PANEL_ABS_MIN_H, Math.floor(height * PANEL_MAX_FILL_H));
  const h = Math.min(wantedH, band - PANEL_MARGIN * 2);
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE WRAPPER BOTH THE PAINTER AND THE HIT TEST USE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Wrapping decides how tall a row is, and this file's header spends a paragraph
 * on why the painter and `talentPanelHitAt` must agree about that to the pixel:
 * a second copy of the arithmetic is a button that lands a row above where it is
 * drawn, on somebody else's window size only.
 *
 * IT IS ITS OWN OFFSCREEN CONTEXT, and that is not the thing the header forbids.
 * What a hit test may not do is remember a RECT from the last frame — stale
 * geometry that swallows clicks at 0,0 on a surface never drawn. A measuring
 * context is not state about a frame; it answers the same question at any time,
 * and using it rather than the painter's own context also means measuring cannot
 * clobber the font the painter had set.
 *
 * INJECTED INTO THE GEOMETRY ANYWAY, so a test can hand it a wrapper with known
 * arithmetic instead of depending on how a headless environment measures a font
 * it does not have.
 */
let measurer: CanvasRenderingContext2D | null | undefined;
export function talentWrapper(): (text: string, maxPx: number) => readonly string[] {
  if (measurer === undefined) {
    measurer =
      typeof document === 'undefined'
        ? null
        : (document.createElement('canvas').getContext('2d') ?? null);
  }
  const ctx = measurer;
  if (ctx === null) return (text) => [text];
  return (text, maxPx) => {
    ctx.font = FONT_BODY;
    return wrapText(ctx, text, maxPx);
  };
}

/**
 * A PASSIVE ROW: the name and rank on one line, its sentence under it, no icon.
 *
 * `TALENT_ROW_H` is 43 and every pixel of it is the icon block plus the `n/max`
 * under it. A passive is a property rather than a button, so it is drawn as one
 * — which is the difference between five talents fitting and four fitting.
 */

/** Baseline of the first line in the detail strip. */
const DETAIL_TOP = 12;

/** Baseline of the first description line, from the top of a talent row. */
/** Distance between two wrapped description lines. */
const DESC_LINE_H = 12;

/**
 * How many vertical pixels one row wants, GIVEN HOW MANY LINES ITS PROSE TOOK.
 *
 * The icon block is 43 tall and two lines of description fit inside it, which is
 * why this was a constant for as long as the description was truncated to one
 * line each. It is not a constant now: a row grows to hold its own sentences.
 */
function rowHeight(row: TalentRow, lines: number): number {
  switch (row.kind) {
    case TalentRowKind.Points:
      return POINTS_ROW_H;
    case TalentRowKind.Category:
      // FIXED, and that is the property that makes the grid legible: every
      // category is the same height whether it holds two talents or five, so
      // the columns line up and the eye can scan across them.
      return CAT_H;
    case TalentRowKind.Detail:
      // GROWS WITH THE PROSE IT HOLDS, and it is the only row that does. This is
      // where the descriptions went when they left the talent rows, so it is the
      // one place in the panel that must never truncate.
      return DETAIL_TOP + lines * DESC_LINE_H;
    case TalentRowKind.Note:
      return NOTE_ROW_H;
  }
}

/** One row, placed, with the `+` it may or may not have. */
export type PlacedTalentRow = {
  readonly row: TalentRow;
  readonly rect: PanelRect;
  /**
   * THE DESCRIPTION, ALREADY BROKEN INTO LINES — and the next-rank one under it.
   *
   * Wrapped HERE rather than in the painter, because the row's height is decided
   * by how many lines there are and a painter that wrapped independently would
   * be the second opinion. The drop policy below reads these heights; if the two
   * disagreed, the panel would reserve room for two lines and draw four.
   */
  readonly descLines: readonly string[];
  readonly nextLines: readonly string[];
  /**
   * ONE RECT PER ICON, index for index with the category's talents. Empty for
   * every row that is not a `Category`.
   *
   * COMPUTED HERE AND NOWHERE ELSE. This file's header spends a paragraph on why
   * the painter and `talentPanelHitAt` must agree to the pixel — ui/partypanel.ts
   * records what a second copy costs, a control that lands a row above where it
   * is drawn on somebody else's window size only. A grid multiplies that risk by
   * five, so the rects travel rather than being re-derived.
   */
  readonly cells: readonly PanelRect[];
  /**
   * The `+` control, or null when there is nothing to buy.
   *
   * NULL AT THE CAP AND NULL WITH AN EMPTY HAND, and it is the same null: a
   * control that is drawn and refuses is worse than one that is not drawn, on a
   * panel whose entire subject is what you can afford.
   */
  readonly plus: PanelRect | null;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE THE CATEGORY GRID SITS, AND HOW FAR DOWN IT HAS BEEN SCROLLED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ THE OFFSET IS APPLIED IN THE GEOMETRY, NOT AT THE PAINT ═══
 * The obvious way to scroll a canvas panel is `ctx.translate` in the painter.
 * It is also the dangerous way HERE: the hit test would then have to subtract
 * the same offset, in a second place, and the two would eventually disagree by
 * exactly `offset` pixels. A talent icon SPENDS A POINT and there is no refund
 * gesture, so a click landing one row off is an irreversible spend on somebody
 * else's live character.
 *
 * `talentPanelHitAt` already calls `talentPanelGeometry`. So the offset is
 * folded into the placed rects — every rect this returns is in POINTER SPACE,
 * already scrolled — and the painter and the pointer cannot drift apart because
 * there is only ever one arithmetic. The painter's only extra job is to CLIP.
 *
 * `viewport` is the window the grid shows through. The hit test refuses a grid
 * row outside it, so a strip scrolled half off the top cannot be clicked on the
 * half that is not there.
 */
export type TalentGridView = {
  readonly viewport: PanelRect;
  /**
   * THE TRACK, and `null` when there is nothing to scroll.
   *
   * Null rather than a zero-height rect so the painter cannot draw a bar for a
   * list that fits — the presence of a bar is the signal that there is more,
   * and a bar that is always there says nothing. ToME hides its slider the same
   * way, on focus (TalentTrees.lua:451-455).
   */
  readonly bar: PanelRect | null;
  /** Where the thumb sits inside `bar`. Null exactly when `bar` is. */
  readonly thumb: PanelRect | null;
  /** The offset actually applied, after clamping. Never negative. */
  readonly scroll: number;
  /** How far it can go. Zero when everything already fits. */
  readonly maxScroll: number;
};

export type TalentPanelGeometry = {
  readonly close: PanelRect;
  /** See `TalentGridView`. */
  readonly grid: TalentGridView;
  /** Rows in reading order, top to bottom. */
  readonly placed: readonly PlacedTalentRow[];
  /**
   * WHERE THE DESCRIPTION GOES, or null on a panel too narrow to have one.
   *
   * DERIVED FROM THE RECT ALONE, like `close` and for the same reason: the hit
   * test and the painter both call this function and must agree to the pixel
   * about what is where. A pane whose presence depended on the ROWS would move
   * under the pointer the first time a category was added.
   */
  readonly detail: PanelRect | null;
  /**
   * WHERE THE SIX ATTRIBUTES GO, or null on a panel too narrow for them.
   *
   * DERIVED FROM THE RECT ALONE, like `close` and `detail` and for the same
   * reason this file states at length: the painter and `talentPanelHitAt` both
   * call this function, and a `+` that lands a row above where it is drawn is a
   * point spent on the wrong attribute — which nothing refunds.
   */
  readonly stats: PanelRect | null;
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
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SIX, IN ToME'S OWN ORDER — `load.lua:182-189`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Strength, Dexterity, Magic, Willpower, Cunning, Constitution. Authored order
 * and never sorted, for the reason the class picker gives about its cards: a row
 * that moves between two frames is a row somebody misclicks, and this one spends
 * a point that nothing refunds.
 *
 * LUCK IS NOT HERE. Upstream defines it, hides it, starts it at 50 and grants no
 * way to raise it — a seventh row would be a promise the rest of the game does
 * not keep.
 *
 * THE SHORT CODE IS WHAT IS DRAWN. Three characters is what fits in 78 pixels
 * beside a value and a `+`, they are upstream's own, and the character sheet a
 * key away spells all six out in full.
 */
export const STAT_ROWS = [
  { key: 'str', label: 'STR', name: 'Strength' },
  { key: 'dex', label: 'DEX', name: 'Dexterity' },
  { key: 'mag', label: 'MAG', name: 'Magic' },
  { key: 'wil', label: 'WIL', name: 'Willpower' },
  { key: 'cun', label: 'CUN', name: 'Cunning' },
  { key: 'con', label: 'CON', name: 'Constitution' },
] as const;

export type StatKey = (typeof STAT_ROWS)[number]['key'];

/** One attribute row is a label, a value and a `+`, on one line. */
const STAT_ROW_H = 14;
/** The `+` is a square at the right-hand end of the row. */
const STAT_PLUS_PX = 11;

/**
 * The take-back badge, in pixels. Deliberately smaller than `STAT_PLUS_PX`:
 * this is the rarest control on the screen and the only destructive one.
 */
const MINUS_PX = 10;

/**
 * Where each attribute row lands inside the column.
 *
 * ONE FUNCTION, TWO READERS — the painter and the hit test — which is this
 * file's standing rule and matters more here than anywhere else in it: a `+`
 * whose hit box is one row above where it is drawn spends a point on the wrong
 * attribute, and there is no `unspend_stat`.
 *
 * A HEADING LINE FIRST. `Stats: 3` is what upstream's dialog leads with and it
 * is the only place the count appears on this screen, so the rows start one line
 * down.
 */
export function statRowRects(box: PanelRect): readonly PanelRect[] {
  const out: PanelRect[] = [];
  const top = box.y + STAT_ROW_H;
  for (let i = 0; i < STAT_ROWS.length; i += 1) {
    const y = top + i * STAT_ROW_H;
    if (y + STAT_ROW_H > box.y + box.h) break;
    out.push({ x: box.x, y, w: box.w, h: STAT_ROW_H });
  }
  return out;
}

/** The `+` inside a row, which is the only part of it that is pressable. */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TAKE-BACK CORNER OF AN ICON. LevelupDialog.lua's `minus`, placed.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A SMALL TARGET IN THE TOP-LEFT, and the smallness is the design rather than a
 * compromise. `talentPanelHitAt` states the panel's rule — *"five plus-buttons
 * inside a 176-pixel strip would each be a small target beside a large one, and
 * the wrong one is always the easy press"* — and that argument is about two
 * controls competing for the SAME action. Here the two actions are opposites,
 * and the risk runs the other way: the common one (arm, then spend) must stay
 * the whole icon, and the rare one must be deliberate. A player cannot take a
 * rank back by fumbling a spend.
 *
 * TOP-LEFT because the rank counter is centred UNDER the icon and the ring is
 * drawn around it; the upper corners are the only quiet pixels a badge can have
 * without covering something a player reads.
 */
export function talentMinusRect(icon: PanelRect): PanelRect {
  return { x: icon.x - 2, y: icon.y - 2, w: MINUS_PX, h: MINUS_PX };
}

export function statPlusRect(row: PanelRect): PanelRect {
  return {
    x: row.x + row.w - STAT_PLUS_PX,
    y: row.y + Math.floor((row.h - STAT_PLUS_PX) / 2),
    w: STAT_PLUS_PX,
    h: STAT_PLUS_PX,
  };
}

export function talentPanelGeometry(
  rect: PanelRect,
  rows: readonly TalentRow[],
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * NO WRAPPER ANY MORE, AND THAT IS THE REDESIGN SHOWING.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This function used to take one, because it decided how tall a row was and a
   * row's height came from how many lines its description wrapped to. The rule
   * behind that — WRAPPING LIVES WHERE THE HEIGHT IS DECIDED, never in the
   * painter — has not changed; what changed is that the geometry no longer holds
   * any prose. Every description moved into the hover card, so `talentTipAt`
   * wraps and this measures icons, which have a fixed size.
   *
   * The parameter is kept in the SIGNATURE and ignored so the callers and their
   * tests read the same before and after; it is documented as dead rather than
   * quietly accepted.
   */
  /**
   * HOW FAR THE CATEGORY GRID IS SCROLLED, in pixels from the top.
   *
   * ═══ NO DEFAULT, ON PURPOSE ═══
   * Four places call this function — the painter, the hit test twice, and one
   * probe in main.ts — and every one of them must use the SAME offset or the
   * pointer and the picture describe different panels. A default would let a
   * call site forget silently; a required argument makes forgetting a compile
   * error, which is the only guarantee worth having when the failure mode is an
   * irreversible talent point.
   *
   * Clamped here rather than by the caller, so the caller may hold any number
   * it likes — a wheel handler adding deltas does not have to know how tall the
   * content is.
   */
  scroll: number,
): TalentPanelGeometry {
  const close = closeRect(rect);
  const x = rect.x + INSET;
  const fullW = Math.max(0, rect.w - INSET * 2);
  const top = rect.y + HEADER_H + INSET;
  const bottom = rect.y + rect.h - INSET;

  /**
   * ═══ THE DESCRIPTION COLUMN IS TAKEN OFF THE RIGHT FIRST ═══
   * Before the grid is measured, so the grid sees only the width it actually
   * has. Doing it the other way round — grid first, pane in what is left — is
   * how a two-column grid ends up half under a description.
   *
   * ONLY WHEN BOTH STILL FIT WHOLE. The test is the grid's own requirement (two
   * columns) plus the pane; a panel that can hold one but not both keeps the
   * grid, because the trees are what the screen is for and the hover card still
   * answers the description question.
   */
  /**
   * ═══ THE ATTRIBUTE COLUMN COMES OFF THE LEFT, BEFORE ANYTHING ELSE ═══
   * Where upstream puts it, and where the eye starts. Taken before the grid is
   * measured so the grid only ever sees width it actually has — doing it the
   * other way round is how a two-column grid ends up half underneath a stat row.
   *
   * IT IS EARNED BEFORE THE DESCRIPTION, which inverts the order the two landed
   * in. See `PANEL_W_STATS`: spending a point has no other route in the game,
   * and reading a description has the hover card.
   */
  const hasStats = fullW >= COL_W * 2 + COL_GAP + COL_GAP + STATS_W;
  const stats: PanelRect | null = hasStats
    ? { x, y: top, w: STATS_W, h: Math.max(0, bottom - top) }
    : null;
  const afterStats = hasStats ? STATS_W + COL_GAP : 0;

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND IT NEEDS A WIDE PANEL, NOT MERELY A PANEL THE PIECES FIT IN.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Ported from LevelupDialog.lua:89-91, which is the whole rule upstream has:
   *
   *     Dialog.init(self, ..., game.w * 0.9, game.h * 0.9, ...)
   *     if game.w * 0.9 >= 1000 then self.no_tooltip = true end
   *
   * The in-dialog description REPLACES the floating tooltip, and it only does so
   * once the dialog is a thousand pixels wide. Below that upstream shows the
   * tooltip and gives the list the whole width.
   *
   * ═══ OURS TRIGGERED AS SOON AS THE PIECES FITTED, WHICH IS FAR TOO EARLY ═══
   * The test was "do two grid columns, the stats strip and the pane all fit",
   * satisfied at `fullW` 622. Measured through this very function, over a
   * character holding eight disciplines, columns of talent trees by viewport:
   *
   *     before  900=2  960=2  1024=2  1100=2  1152=2  1280=3  1440=4  1920=5
   *     after   900=3  960=3  1024=3  1100=3  1152=2  1280=3  1440=4  1920=5
   *
   * A THOUSAND-PIXEL-WIDE WINDOW WAS SHOWING TWO COLUMNS OF DISCIPLINES while
   * spending 280 pixels on a description the hover card already gives. Every
   * width in the range gains one, and none loses.
   *
   * ═══ THE STEP AT THE THRESHOLD IS INHERENT, AND IS NOT A BUG TO CHASE ═══
   * The pane is a FIXED 266 and the grid is width-packed, so taking it always
   * costs about one column — the grid's own curve without it runs 900=3
   * 1152=4 1440=5 1920=7, roughly one above the with-pane curve everywhere.
   * There is therefore NO threshold at which the pane can appear for free: the
   * count steps down by one wherever it lands. Raising the threshold only moves
   * the step to a wider window and costs every window below it a column of
   * prose it had.
   *
   * So the step is priced, not eliminated, and 1000 is where upstream prices it.
   * `never costs the grid more than one column` below is the guard on that.
   *
   * ═══ THE DECISION THAT ADDED THIS COLUMN RESTED ON A PREMISE THAT MOVED ═══
   * DECISIONS.md, "The talent screen gets ToME's description column": *"A column
   * costs WIDTH, which the grid cannot use anyway: it packs into two fixed
   * columns and a third will not fit."*
   *
   * True when written. The grid stopped packing into two fixed columns in a
   * later pass — see the note under `columns` below, which records that the old
   * `innerW >= COL_W * 2 + COL_GAP ? 2 : 1` rule was "costing whole talent
   * trees". The grid uses every pixel it is given now, so the one reason the
   * column was affordable is gone, and the threshold goes back to upstream's.
   *
   * The hover card still stands up wherever the column stands down — the
   * geometry owns that decision and this is still the single place it is made.
   */
  const hasDetail =
    rect.w >= DETAIL_MIN_PANEL_W &&
    fullW >= COL_W * 2 + COL_GAP + COL_GAP + STATS_W + COL_GAP + DETAIL_W;
  const detail: PanelRect | null = hasDetail
    ? {
        x: x + fullW - DETAIL_W,
        y: top,
        w: DETAIL_W,
        h: Math.max(0, bottom - top),
      }
    : null;
  const innerW = (hasDetail ? fullW - DETAIL_W - COL_GAP : fullW) - afterStats;

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * HOW MANY COLUMNS OF CATEGORIES FIT, WHICH IS ONE OR TWO AND NEVER THREE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * One is the honest answer on a window too narrow to hold two — the strips
   * stack instead of being squeezed, because a five-icon strip cannot shrink:
   * every icon is a click target and a 20-pixel icon is a miss waiting to happen.
   *
   * ═══ AND THE CEILING OF TWO WAS COSTING WHOLE TALENT TREES ═══
   * This read `innerW >= COL_W * 2 + COL_GAP ? 2 : 1` — two columns, however
   * much room there was. A strip is `COL_W` = 118 wide, so two of them plus the
   * gap is 246 pixels; the panel at the viewport this game actually renders is
   * 572 wide with 556 inside it. THREE HUNDRED AND TEN PIXELS SAT EMPTY while
   * the grid ran out of vertical room and dropped categories with a row reading
   * "N categories hidden — panel too small".
   *
   * MEASURED at that panel: 2 columns x 3 lines = 6 strips, against the 8 a
   * class can hold (three of its own, two open generics, three locked). Two
   * disciplines invisible, on a panel with half its width unused. Reported as
   * "the talent (G) is too small to accomodate and the page says so".
   *
   * As many as fit at full width, which is 4 there — 12 strips against 8, and
   * the drop stops. The strips never shrink; there are simply more of them per
   * line, which is the one axis this grid had spare.
   */
  /**
   * ═══ THE SCROLLBAR GUTTER IS TAKEN OFF THE TOP, ALWAYS ═══
   * Reserved whether or not this list can actually scroll, which costs seven
   * pixels on a panel that never needs them. Both alternatives are worse:
   *
   *   - Letting the bar OVERLAY the grid puts a decoration on top of the right
   *     edge of an icon, and icons here spend points with no refund.
   *   - Reserving it only WHEN the list overflows makes the column count depend
   *     on whether it overflows, which depends on the column count. Even if that
   *     knot were untied, the grid would reflow the instant a talent tree was
   *     unlocked — icons sliding to new columns under a pointer that is already
   *     moving toward one.
   *
   * A constant gutter means the grid a player learned the shape of stays that
   * shape.
   */
  const gridSpace = Math.max(0, innerW - (BAR_W + BAR_GAP));
  const columns = Math.max(1, Math.floor((gridSpace + COL_GAP) / (COL_W + COL_GAP)));
  const gridW = columns * COL_W + (columns - 1) * COL_GAP;
  /** CENTRED. A left-aligned grid in a wider panel reads as a layout bug. */
  const gridX = x + afterStats + Math.max(0, Math.floor((gridSpace - gridW) / 2));
  /** THE GUTTER ITSELF, at the right edge of the space the grid was fitted to. */
  const barX = x + afterStats + gridSpace + BAR_GAP;

  const categories = rows.filter((row) => row.kind === TalentRowKind.Category);
  const others = rows.filter((row) => row.kind !== TalentRowKind.Category);

  const placed: PlacedTalentRow[] = [];
  let cursor = top;

  // ── the sentence rows, above the grid ────────────────────────────────────
  //
  // IN THE GRID'S SPACE, NOT THE PANEL'S. `afterStats` is the reserve taken off
  // the LEFT for the attribute column, and it was applied to `gridX` and `barX`
  // and not to these — so the sentence started at the panel's inset while
  // carrying the already-narrowed `innerW`, and `drawStats` (which runs last)
  // overprinted its first 42 pixels. Reported verbatim as `Stats:9to spend`,
  // which is `Stats: 9` and `9 stat to spend` sharing an origin six pixels
  // apart on the same baseline. Aligning to `gridX`/`gridW` also puts the
  // sentence over the strips it is about.
  for (const row of others) {
    const h = rowHeight(row, 1);
    if (cursor + h > bottom) break;
    placed.push({
      row,
      rect: { x: gridX, y: cursor, w: gridW, h },
      plus: null,
      descLines: [],
      nextLines: [],
      cells: [],
    });
    cursor += h;
  }

  // ── the grid ─────────────────────────────────────────────────────────────
  /**
   * THE WHOLE BAND IS THE GRID'S NOW.
   *
   * An earlier version of this reserved a strip at the foot for the hovered
   * talent's description. A hover CARD replaced it, on the ask, and the height
   * that strip was costing on every frame — whether or not anything was being
   * pointed at — is now another row of categories.
   */
  const gridBottom = bottom;

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE GRID SCROLLS NOW, SO NOTHING IS DROPPED FOR WANT OF ROOM.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This loop used to stop at the first strip that would not fit and report the
   * rest as "N categories hidden — panel too small". Widening the panel bought
   * some of them back and could never buy them all: the tree count grows with
   * content and the band between the HUD docks does not.
   *
   * Upstream scrolls instead — TalentTrees.lua:72 gives the list a slider and
   * :388 clips it with `glScissor` — and a scrolled list has no ceiling at all.
   *
   * ═══ THE CLAMP IS `content - viewport`, WHICH IS NOT WHAT ToME USES ═══
   * TalentTrees.lua:350 sets `self.scrollbar.max = self.max_h`, which lets a
   * pane scroll a whole viewport past its own end and leaves the reader staring
   * at blank space wondering what they missed. TextzoneList.lua:148 has it
   * right — `self.scrollbar.max = self.max_h - self.h` — and that is the one
   * ported here. Where upstream disagrees with itself, the version that cannot
   * strand the reader wins.
   */
  const gridLines = Math.ceil(categories.length / columns);
  const contentH = gridLines * CAT_H;
  const viewportH = Math.max(0, gridBottom - cursor);
  const maxScroll = Math.max(0, contentH - viewportH);
  const applied = Math.max(0, Math.min(Math.floor(scroll), maxScroll));
  const gridViewport: PanelRect = { x: gridX, y: cursor, w: gridW, h: viewportH };

  /**
   * THE THUMB IS PROPORTIONAL, and its travel is `track - thumb` rather than
   * `track`, for the same reason `maxScroll` is `content - viewport`: a thumb
   * that runs to the bottom of its track only when it has already left it tells
   * the player they have more to read when they are at the end.
   */
  const bar: PanelRect | null =
    maxScroll > 0 && viewportH > 0 ? { x: barX, y: cursor, w: BAR_W, h: viewportH } : null;
  const thumb: PanelRect | null =
    bar === null
      ? null
      : (() => {
          const h = Math.max(
            BAR_MIN_THUMB,
            Math.floor(bar.h * Math.min(1, viewportH / Math.max(1, contentH))),
          );
          const travel = Math.max(0, bar.h - h);
          return {
            x: bar.x,
            y: bar.y + Math.round(travel * (applied / maxScroll)),
            w: bar.w,
            h,
          };
        })();

  for (let i = 0; i < categories.length; i += 1) {
    const row = categories[i];
    if (row === undefined || row.kind !== TalentRowKind.Category) continue;
    const col = i % columns;
    const line = Math.floor(i / columns);
    /**
     * ALREADY IN POINTER SPACE. Every rect this loop produces is where the
     * strip actually IS on screen, scroll included — see `TalentGridView` for
     * why the offset is applied here and not with a `ctx.translate` in the
     * painter.
     */
    const y = cursor + line * CAT_H - applied;
    /**
     * A STRIP ENTIRELY ABOVE OR BELOW THE WINDOW IS NOT PLACED AT ALL.
     *
     * Not merely invisible: UNPLACED. A rect the painter clips away is still in
     * the list the HIT TEST walks, and the hazard is not hypothetical — the
     * sentence rows are laid out immediately above `cursor`, so a strip scrolled
     * off the top of the window carries a negative-ish `y` that lands squarely
     * on top of them. A player clicking the points sentence would spend a point
     * on a discipline that is not on the screen, and there is no refund gesture.
     *
     * Clipping in the painter would hide the strip and leave that click armed.
     * The cheapest way to disarm it is for the row not to exist.
     */
    if (y + CAT_H <= cursor || y >= gridBottom) continue;
    const bx = gridX + col * (COL_W + COL_GAP);
    const cells: PanelRect[] = row.talents.map((_, n) => ({
      x: bx + n * (ICON_PX + CELL_GAP),
      y: y + CAT_HEAD_H,
      w: ICON_PX,
      h: ICON_PX,
    }));
    placed.push({
      row,
      rect: { x: bx, y, w: COL_W, h: CAT_H },
      plus: null,
      descLines: [],
      nextLines: [],
      cells,
    });
  }
  /**
   * AND `cursor` IS NOT ADVANCED, BECAUSE THE GRID IS THE LAST THING PLACED.
   *
   * The sentence rows are laid out ABOVE the grid and the grid runs to
   * `gridBottom`, so there is nothing below it to push down. The old advance
   * was already dead weight; a scrolled grid makes it actively misleading,
   * since "how far down the content reached" and "how far down the panel is
   * used" stopped being the same number the moment the list could exceed its
   * window.
   */

  /**
   * ═══ THERE IS NO "N CATEGORIES HIDDEN" ROW ANY MORE, AND THAT IS THE FIX ═══
   *
   * The grid used to stop at the first strip that would not fit and say so, on
   * ui/caselog.ts's rule that a surface which has quietly stopped showing
   * everything must never make the reader infer it. The rule was right and the
   * row was honest; a player still could not see two of their own disciplines.
   *
   * A scrolled grid has no tail to concede, so the honest thing to print is
   * nothing. The rule is not being abandoned — it is being satisfied.
   */

  return {
    close,
    grid: { viewport: gridViewport, bar, thumb, scroll: applied, maxScroll },
    placed,
    detail,
    stats,
  };
}

export const TalentHitKind = {
  /** The × on the header. The mouse's copy of the key that opened the panel. */
  Close: 'close',
  /** A row's `+`. The caller runs it through `pressSpend`. */
  Spend: 'spend',
  /**
   * THE `-` ON AN ICON — take one rank back. Only ever produced for a cell the
   * SERVER marked `unlearnable`, so the panel cannot offer a refund the server
   * will refuse.
   */
  Unlearn: 'unlearn',
  /** Somewhere on a talent row, but not on its `+`. Cosmetic — it hovers. */
  Row: 'row',
  /**
   * An attribute's `+` in the left column. Carries the stat, not an index —
   * `spend_stat` names one of the six and an index would be a second ordering
   * to keep in step with `STAT_ROWS`.
   */
  Stat: 'stat',
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
  | { readonly kind: typeof TalentHitKind.Stat; readonly stat: StatKey }
  | { readonly kind: typeof TalentHitKind.Close }
  | {
      readonly kind: typeof TalentHitKind.Spend;
      readonly index: number;
      readonly talentId: string;
    }
  | {
      /**
       * CARRIES AN `index` LIKE `Spend` DOES, and it has to: main.ts's hover
       * block reads `hit.index` for every kind except `Close`, and a variant
       * without one stops that line compiling. See the `Header` note below,
       * which is the same constraint that forced a whole second reader.
       */
      readonly kind: typeof TalentHitKind.Unlearn;
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
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CATEGORY HEADER'S OWN BAND — where a deepen press lands.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `CAT_HEAD_H` pixels off the top of a placed category, which is exactly the
 * strip the heading text is painted into. ONE COPY of the arithmetic, read by
 * the painter and by `talentDeepenAt`, for the reason this file's header gives
 * about the icon rects: two authorities on where a control is will disagree, and
 * the one that disagrees silently is the painter.
 *
 * IT IS THE WHOLE HEADING AND NOT A SMALL BUTTON AT ITS END. The icons below it
 * are already 24-pixel targets in a 176-pixel strip; adding a smaller one above
 * them would be the "five plus-buttons" failure `talentHitAt` refuses, and the
 * heading is dead space today with nothing else to hit.
 */
export function categoryHeadRect(rect: PanelRect): PanelRect {
  return { x: rect.x, y: rect.y, w: rect.w, h: CAT_HEAD_H };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A PRESS ON A CATEGORY HEADING MEANS — a second reader, as `Header` is.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Returns the tree id to spend a category point deepening, or null.
 *
 * ═══ WHY NOT A FOURTH `TalentHit` VARIANT ═══
 * `TalentPanelDrag`'s docblock has the whole argument and it applies unchanged:
 * main.ts's hover block reads `talentHit.index` for every kind but two, and a
 * variant carrying a tree id instead of an index stops that line compiling in a
 * file this panel does not own, for an outcome hovering has nothing to do with.
 * The CLICK union keeps the outcomes a click can have and stays total; a press
 * that means something else gets its own reader over the same geometry. Two
 * precedents already: this file's `Header`, and ui/inventory.ts:1270-1300.
 *
 * READS `row.deepen`, WHICH IS THE SERVER'S ANSWER — the tree is known, has not
 * been deepened, and a point is in hand. A reader that decided for itself would
 * be a fourth authority on a rule the server enforces.
 */
export function talentPanelDeepenAt(
  rect: PanelRect,
  rows: readonly TalentRow[],
  px: number,
  py: number,
  /** THE SAME OFFSET THE PAINTER USED — `talentPanelHitAt` states the cost. */
  scroll: number,
): string | null {
  return talentDeepenAt({ x: px, y: py }, talentPanelGeometry(rect, rows, scroll));
}

export function talentDeepenAt(
  point: { readonly x: number; readonly y: number },
  geometry: TalentPanelGeometry,
): string | null {
  for (const placed of geometry.placed) {
    if (placed.row.kind !== TalentRowKind.Category) continue;
    if (!placed.row.deepen) continue;
    const head = categoryHeadRect(placed.rect);
    // CLIPPED AWAY IS NOT PRESSABLE, the rule `talentHitAt` applies to icons.
    if (!cellOnScreen(head, geometry.grid.viewport)) continue;
    if (
      point.x >= head.x &&
      point.x < head.x + head.w &&
      point.y >= head.y &&
      point.y < head.y + head.h
    ) {
      return placed.row.tree;
    }
  }
  return null;
}

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
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IS THIS ICON ACTUALLY ON SCREEN? — asked of every grid cell before it answers
 * a pointer.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `talentPanelGeometry` refuses to place a strip that is ENTIRELY outside the
 * scroll window, which closes the large hole. This closes the small one: a strip
 * scrolled HALFWAY off the top is still placed — it must be, the visible half
 * has to be drawn — and it brings all five of its cells with it, including ones
 * whose boxes now sit above the window entirely.
 *
 * The painter clips those away, so they are not on the screen. Without this test
 * the hit walk would still match them, and a press on what looks like empty
 * panel above the grid would SPEND A POINT on an icon the player cannot see.
 * That is the exact failure the whole scroll design is arranged against, one
 * scale down.
 *
 * ═══ FULL CONTAINMENT, NOT OVERLAP ═══
 * A half-clipped icon is refused rather than accepted on its visible part. Its
 * drawn shape and its hit box would otherwise disagree — the player aims at what
 * they can see, the box extends past the clip — and "close enough" is not a
 * standard worth holding when the miss costs a talent point with no refund.
 */
function cellOnScreen(box: PanelRect, viewport: PanelRect): boolean {
  return (
    box.x >= viewport.x &&
    box.y >= viewport.y &&
    box.x + box.w <= viewport.x + viewport.w &&
    box.y + box.h <= viewport.y + viewport.h
  );
}

export function talentPanelHitAt(
  rect: PanelRect,
  rows: readonly TalentRow[],
  px: number,
  py: number,
  /**
   * THE SAME OFFSET THE PAINTER USED. Required for the reason
   * `talentPanelGeometry` states: a hit test working from a different scroll
   * than the picture is a click that spends a talent point on the wrong talent.
   */
  scroll: number,
  /**
   * WHICH TALENT IS ARMED, so a press on it reads as the CONFIRM half of
   * `pressSpend` rather than as another arm. Optional, because a caller that is
   * only asking "what is under the pointer" — the hover path — has no arming to
   * report and must not be made to invent one.
   */
  armedId: string | null = null,
): TalentHit | null {
  const inside = (r: PanelRect): boolean =>
    px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;

  const geometry = talentPanelGeometry(rect, rows, scroll);
  if (inside(geometry.close)) return { kind: TalentHitKind.Close };

  /**
   * ═══ THE ATTRIBUTE COLUMN, BEFORE THE GRID ═══
   * They do not overlap — the geometry takes the column off the left before the
   * grid is measured — so the order is not load-bearing for correctness. It is
   * still first because it is first on screen, and because a reader tracing a
   * press down this function should meet the surfaces in the order the eye does.
   *
   * ONLY THE `+` ANSWERS. The rest of a row is a label and a number, and a hit
   * on it would arm a spend the player never aimed at — the same reason the
   * grid's `+` is the icon rather than a separate button, in reverse: here there
   * IS room for a small target, so the small target is what is asked about.
   */
  const statBox = geometry.stats;
  if (statBox !== null) {
    const rowRects = statRowRects(statBox);
    for (let i = 0; i < rowRects.length; i += 1) {
      const row = rowRects[i];
      const entry = STAT_ROWS[i];
      if (row === undefined || entry === undefined) continue;
      if (inside(statPlusRect(row))) return { kind: TalentHitKind.Stat, stat: entry.key };
    }
  }

  for (const placed of geometry.placed) {
    if (placed.row.kind !== TalentRowKind.Category) continue;
    /**
     * THE ICONS, AGAINST THE RECTS THE GEOMETRY COMPUTED — never re-derived from
     * the row's position. This file's header argues at length that the painter
     * and this function must agree to the pixel; a grid gives five chances per
     * category to disagree instead of one, so the rects travel.
     */
    const talents = placed.row.talents;
    for (let n = 0; n < placed.cells.length; n += 1) {
      const box = placed.cells[n];
      const cell = talents[n];
      if (box === undefined || cell === undefined) continue;
      if (!inside(box)) continue;
      // CLIPPED AWAY IS NOT CLICKABLE. See `cellOnScreen`.
      if (!cellOnScreen(box, geometry.grid.viewport)) continue;
      /**
       * AN ICON IS THE `+`. There is no separate plus button in the grid, and
       * that is the design rather than an omission: five plus-buttons inside a
       * 176-pixel strip would each be a small target beside a large one, and the
       * wrong one is always the easy press.
       *
       * `pressSpend` already owns the two-press rule — arm, then confirm, with
       * "there is no refund" said in between — so a press on an ARMED icon is a
       * spend and a press on any other is an arm. That is the same safety the
       * old `+` had, on a bigger target.
       */
      /**
       * THE TAKE-BACK CORNER IS TESTED FIRST, and it has to be: it is carved
       * OUT of the icon's own box, so a fall-through to the icon would make the
       * badge unreachable. It needs no arm/confirm of its own — the two-press
       * rule exists because a spend is irreversible, and this is the thing that
       * makes one reversible.
       */
      if (cell.canUnlearn && inside(talentMinusRect(box))) {
        return { kind: TalentHitKind.Unlearn, index: n, talentId: cell.id };
      }
      return cell.id === armedId && cell.canSpend
        ? { kind: TalentHitKind.Spend, index: n, talentId: cell.id }
        : { kind: TalentHitKind.Row, index: n };
    }
  }

  return null;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE POINTER IS OVER, AS A CARD. The hover half of the tree.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The talent screen shows fifteen icons and no prose; this is where the prose
 * went. Asked for directly, and it is also what makes the grid affordable —
 * every description printed inline was a row, and rows are what ran out.
 *
 * IT REUSES `talentPanelHitAt` RATHER THAN WALKING THE GRID AGAIN. The card must
 * appear over exactly the icon a click would hit, and two traversals of the same
 * rects are two chances to disagree about which one that is.
 */
/**
 * The cell under the pointer. Split out because `talentTipAt` needs the TALENT
 * and `talentPanelHitAt` needs only its index — and an index alone cannot name a
 * talent once categories exist, since index 0 means something different in every
 * one of them.
 */
function cellAt(
  rows: readonly TalentRow[],
  index: number,
  px: number,
  py: number,
  rect: PanelRect,
  /** The same offset the painter used — see `talentPanelGeometry`. */
  scroll: number,
): TalentCell | undefined {
  const geometry = talentPanelGeometry(rect, rows, scroll);
  for (const placed of geometry.placed) {
    if (placed.row.kind !== TalentRowKind.Category) continue;
    const box = placed.cells[index];
    if (box === undefined) continue;
    if (px < box.x || px >= box.x + box.w || py < box.y || py >= box.y + box.h) continue;
    // THE SAME REFUSAL THE PRESS MAKES, so the hover card cannot describe an
    // icon the press would decline to spend on. See `cellOnScreen`.
    if (!cellOnScreen(box, geometry.grid.viewport)) continue;
    return placed.row.talents[index];
  }
  return undefined;
}

/**
 * WHICH TALENT IS UNDER THE POINTER, BY ID, or null.
 *
 * THE SAME TRAVERSAL A CLICK AND A CARD USE, for the reason this file repeats:
 * the description column, the hover card and the press must all be about the
 * same icon, and three walks of the same rects are three chances to disagree
 * about which one that is.
 *
 * AN ID RATHER THAN AN INDEX, because an index alone cannot name a talent once
 * there are categories — index 0 means something different in every one of them,
 * which is exactly the bug `cellAt` was split out to prevent.
 */
export function talentIdAt(
  rect: PanelRect,
  rows: readonly TalentRow[],
  px: number,
  py: number,
  /** The same offset the painter used — see `talentPanelGeometry`. */
  scroll: number,
): string | null {
  const hit = talentPanelHitAt(rect, rows, px, py, scroll);
  // AN ATTRIBUTE `+` IS NOT A TALENT. It is on the same panel and answers the
  // same hit test, and it has no cell behind it — so it takes the same exit the
  // × does rather than being asked for an index it does not carry.
  if (hit === null || hit.kind === TalentHitKind.Close || hit.kind === TalentHitKind.Stat) {
    return null;
  }
  return cellAt(rows, hit.index, px, py, rect, scroll)?.id ?? null;
}

export function talentTipAt(
  rect: PanelRect,
  rows: readonly TalentRow[],
  px: number,
  py: number,
  /** The same offset the painter used — see `talentPanelGeometry`. */
  scroll: number,
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT EACH ATTRIBUTE IS BUYING, from `ProgressMsg.statGains`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * OPTIONAL, so a server that does not send them — or a fixture — produces the
   * card behaviour this panel has always had, which is no card over a stat row
   * at all.
   */
  statGains?: Readonly<Record<string, readonly string[]>>,
): HoverCard | null {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE ATTRIBUTE COLUMN ANSWERS FIRST, AND ONLY TO A HOVER.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `talentPanelHitAt` states the press rule for this column and it is
   * unchanged: *"ONLY THE `+` ANSWERS. The rest of a row is a label and a
   * number, and a hit on it would arm a spend the player never aimed at."*
   *
   * A HOVER IS NOT A PRESS, which is the whole reason this can be a second
   * reader over the same geometry rather than a new `TalentHit` variant — the
   * same split the file already makes for `Header`, and for the same stated
   * reason. Pointing at a row is safe; pressing it is not.
   *
   * ═══ WHY THE ROW AND NOT JUST THE `+` ═══
   * The card is the thing that makes the `+` a decision rather than a guess, so
   * it has to be readable BEFORE the pointer is over the button. A player
   * hovering the word "Constitution" is asking exactly the question this
   * answers.
   */
  if (statGains !== undefined) {
    const statBox = talentPanelGeometry(rect, rows, scroll).stats;
    if (statBox !== null) {
      const rowRects = statRowRects(statBox);
      for (let i = 0; i < rowRects.length; i += 1) {
        const row = rowRects[i];
        const entry = STAT_ROWS[i];
        if (row === undefined || entry === undefined) continue;
        if (px < row.x || px >= row.x + row.w || py < row.y || py >= row.y + row.h) continue;
        const lines = statGains[entry.key] ?? [];
        return {
          title: entry.name,
          meta: 'per point',
          // AND IT SAYS SO WHEN IT BUYS NOTHING. A stat with an empty list is a
          // real answer — a body whose Magic feeds nothing it owns — and a card
          // that vanished would read as a broken hover.
          lines: lines.length === 0 ? ['Nothing this body can use.'] : [...lines],
        };
      }
    }
  }

  /**
   * THE SAME TRAVERSAL A CLICK USES, so the card appears over exactly the icon a
   * press would hit. Two walks of the same rects are two chances to disagree
   * about which one that is.
   *
   * `armedId` is deliberately not passed: whether a talent is armed changes what
   * a PRESS means, never what the pointer is OVER, and a hover that reported
   * `Spend` would put the card on a different code path for no reason.
   */
  const hit = talentPanelHitAt(rect, rows, px, py, scroll);
  // NO CARD OVER AN ATTRIBUTE. There is no cell behind one, and the column
  // already draws its own name and value — a card repeating them would be the
  // same words twice with one copy following the pointer.
  if (hit === null || hit.kind === TalentHitKind.Close || hit.kind === TalentHitKind.Stat) {
    return null;
  }

  const cell = cellAt(rows, hit.index, px, py, rect, scroll);
  if (cell === undefined) return null;

  const wrap = talentWrapper();
  // A CARD WIDE ENOUGH TO READ AND NARROW ENOUGH TO SIT BESIDE ITS ICON. 240 is
  // about forty monospace characters, which is a sentence and a half.
  const width = 240;
  return {
    // "0/5" IS THE HONEST COUNTER and it is left as it is — the card is a
    // glance, and a word where a number belongs makes the column ragged. The
    // pane behind it spells out what 0 means.
    title: `${cell.name}  ${cell.level}/${cell.maxLevel}`,
    // WHAT IT COSTS TO PRESS, or that it is never pressed. Printing an AP cost
    // on a passive would be a lie about how the talent works.
    meta: cell.passive
      ? 'always on'
      : [
          `${cell.cost.ap} AP`,
          cell.cost.resource > 0 ? `${cell.cost.resource} resolve` : null,
          cell.cooldownTurns > 0 ? `${cell.cooldownTurns}t cooldown` : null,
          cell.range >= 2 ? `${cell.range} tiles` : 'melee',
        ]
          .filter((part) => part !== null)
          .join('  ·  '),
    // THE REFUSAL RIDES WITH THE DESCRIPTION rather than in `nextLines`, which
    // this card paints gold — a lock rendered in the "what one point buys"
    // colour would be the one sentence on the card that means its opposite.
    lines: [
      ...wrap(cell.desc, width),
      ...(cell.lockedReason === null ? [] : wrap(cell.lockedReason, width)),
    ],
    nextLines: cell.descNext === null ? [] : wrap(`${ARROW} ${cell.descNext}`, width),
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *      ONE TALENT, IN FULL, DOWN THE RIGHT — ToME's LEVELUP RIGHT PANE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The screenshot is a labelled list under a gold name: current level and what
 * the next one would be, then use mode, cost, range, cooldown, then the
 * sentence. Every line is `Label: value` with the LABEL dim and the VALUE lit,
 * because a column of green labels is a wall and the value is what is being read.
 *
 * ═══ THE NEXT RANK IS WRITTEN BESIDE THE CURRENT ONE, NOT UNDER IT ═══
 * `2 [-> 3]` is upstream's exact grammar and it is better than a second
 * paragraph: the question a player is answering is "what does this point BUY",
 * and an answer that makes them hold two numbers in their head across four lines
 * is answering a different one. `ARROW` is the same glyph the hover card uses.
 *
 * IT DRAWS NOTHING WHEN NOTHING IS FOCUSED except a line saying so — an empty
 * column reads as a panel that failed to load, and this screen is most often
 * opened by somebody who does not know what they are looking at yet.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE SIX DOWN THE LEFT — ToME'S LEVELUP DIALOG, WITH THE POINTS ON TOP.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Stats: 3` and then six rows of `STR 25 +`. Upstream leads its dialog with the
 * count and so does this: it is the only place on the screen that says how many
 * attribute points are in hand, and a column of numbers with no count above it
 * does not tell a player there is anything to do here.
 *
 * ═══ THE `+` IS DRAWN ONLY WHEN IT WOULD DO SOMETHING ═══
 * No points, no `+`. That is the opposite of the rule the grid follows — its
 * icons stay pressable-looking because an icon IS the talent — and the reason
 * for the difference is that a `+` is a control and nothing else. One that is
 * always there teaches a player to press it and be refused, and the refusal
 * costs a round trip to be told something the screen already knew.
 *
 * ═══ AND THE VALUE IS THE COMPOSED ONE ═══
 * `ProgressMsg.stats` is read off `combat` after `recomposeCombat`, so it is
 * class plus spent points plus gear plus passives — what the character sheet
 * says, and what a player can check. A column showing the raw class base would
 * disagree with the sheet one key away.
 */
function drawStats(
  ctx: CanvasRenderingContext2D,
  box: PanelRect,
  values: Readonly<Record<string, number>> | null,
  unspent: number,
  armed: string | null,
  /** As bought. Null against a server that does not send it. See `statBase`. */
  bought: Readonly<Record<string, number>> | null,
  level: number,
): void {
  if (box.w <= 0 || box.h <= 0) return;

  // A HAIRLINE DOWN THE INSIDE EDGE, matching the description column's. The
  // panel is one window with three columns, not three panels.
  ctx.fillStyle = PALETTE.SLATE;
  ctx.fillRect(box.x + box.w + Math.floor(COL_GAP / 2), box.y, 1, box.h);

  ctx.font = FONT_META;
  // GOLD WHILE THERE IS SOMETHING TO SPEND, grey when there is not — the same
  // signal the escape menu's `TALENTS (2)` uses for the other currency.
  ctx.fillStyle = unspent > 0 ? PALETTE.GOLD : PALETTE.GREY;
  ctx.fillText(`Stats: ${String(unspent)}`, box.x, box.y + STAT_ROW_H / 2);

  if (values === null) return;

  const rects = statRowRects(box);
  ctx.font = FONT_BODY;
  for (let i = 0; i < rects.length; i += 1) {
    const row = rects[i];
    const entry = STAT_ROWS[i];
    if (row === undefined || entry === undefined) continue;
    const value = values[entry.key] ?? 0;
    const base = bought?.[entry.key] ?? null;
    const mid = row.y + row.h / 2;

    ctx.fillStyle = PALETTE.GREY_HI;
    ctx.fillText(entry.label, row.x, mid);
    /**
     * ═══ `25 (20)` — COMPOSED, WITH WHAT YOU BOUGHT IN BRACKETS ═══
     * LevelupDialog.lua:624-627 draws exactly this pair, and it answers the
     * question a single number cannot: how much of my Strength is MINE. It also
     * explains a greyed `+` beside a value that looks nowhere near any limit —
     * the ceiling binds on the bracketed number.
     *
     * ONLY WHEN THEY DIFFER. Printing `(20)` beside a bare 20 on every row would
     * be furniture, and the same argument the mastery header makes for leaving
     * `(x1.00)` unsaid.
     */
    ctx.fillStyle = PALETTE.PARCHMENT;
    const shown =
      base === null || Math.round(base) === Math.round(value)
        ? String(Math.round(value))
        : `${String(Math.round(value))} (${String(Math.round(base))})`;
    ctx.fillText(shown, row.x + 26, mid);

    if (unspent <= 0) continue;

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE `+` GOES DEAD AT THE LEVEL CEILING — LevelupDialog.lua:255-260.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Upstream refuses the press AND paints the row when either clause binds
     * (:584, :593, :610-616), so a player learns the limit before spending
     * rather than by being told no. This is that, on the control itself.
     *
     * ASKED OF THE BOUGHT VALUE, not the composed one — see `statBase`. With no
     * base in hand (an older server) every `+` stays live and the server's
     * refusal is the backstop, which is the behaviour this column has always had.
     */
    const capped = base !== null && !canRaiseStat(base, level);
    const plus = statPlusRect(row);
    const isArmed = armed === entry.key && !capped;
    // ARMED IS A FILL, NOT A COLOUR CHANGE ALONE — `ui/partypanel.ts` states the
    // rule this file follows everywhere: never colour alone.
    ctx.fillStyle = isArmed ? PALETTE.GOLD : PALETTE.SLATE;
    ctx.fillRect(plus.x, plus.y, plus.w, plus.h);
    /**
     * AND A CAPPED CONTROL WEARS A DASH, NOT A PLUS. A greyed `+` is still a
     * plus, and the one thing a player must not do here is press hopefully at a
     * control that has nothing to give — the glyph change is the shape signal
     * this file uses everywhere in place of colour alone.
     */
    ctx.fillStyle = capped ? PALETTE.GREY : isArmed ? PALETTE.INK : PALETTE.BONE;
    ctx.textAlign = 'center';
    ctx.fillText(capped ? '–' : '+', plus.x + plus.w / 2, plus.y + plus.h / 2);
    ctx.textAlign = 'left';
  }
}

function drawDetail(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  box: PanelRect,
  cell: TalentCell | null,
  wrap: (text: string, maxPx: number) => readonly string[],
): void {
  if (box.w <= 0 || box.h <= 0) return;

  // A HAIRLINE, NOT A BOX. The pane is part of the panel rather than a second
  // panel inside it, and a full border would read as a nested window.
  ctx.fillStyle = PALETTE.SLATE;
  ctx.fillRect(box.x - Math.floor(COL_GAP / 2), box.y, 1, box.h);

  const x = box.x + 6;
  const w = box.w - 12;
  let y = box.y + 4;
  const bottom = box.y + box.h;

  const line = (text: string, font: string, ink: string, gap = 12): void => {
    if (y + gap > bottom) return;
    ctx.font = font;
    ctx.fillStyle = ink;
    ctx.fillText(fitText(ctx, text, w), x, y + gap / 2);
    y += gap;
  };

  if (cell === null) {
    line('Point at a talent.', FONT_BODY, PALETTE.GREY);
    return;
  }

  // THE ICON BESIDE THE NAME, so the pane and the grid are visibly about the
  // same thing — the eye travels from the icon it clicked to the icon up here.
  const iconBox = { x, y, w: ICON_PX, h: ICON_PX };
  drawTalentIcon(ctx, sprites, cell.icon, cell.name, iconBox, PALETTE.SLATE);

  const textX = x + ICON_PX + 6;
  ctx.font = FONT_META;
  ctx.fillStyle = PALETTE.GOLD;
  ctx.fillText(fitText(ctx, cell.name, w - ICON_PX - 6), textX, y + 8);
  ctx.font = FONT_BODY;
  ctx.fillStyle = PALETTE.GREY_HI;
  ctx.fillText(
    fitText(ctx, cell.passive ? 'Passive — always on' : 'Activated', w - ICON_PX - 6),
    textX,
    y + 21,
  );
  y += ICON_PX + 6;

  /** `Label: value`, with the label dim so the value is what the eye lands on. */
  const field = (label: string, value: string, ink: string = PALETTE.PARCHMENT): void => {
    if (y + 12 > bottom) return;
    ctx.font = FONT_BODY;
    ctx.fillStyle = PALETTE.GREY;
    const head = `${label}: `;
    ctx.fillText(head, x, y + 6);
    const headW = ctx.measureText(head).width;
    ctx.fillStyle = ink;
    ctx.fillText(fitText(ctx, value, w - headW), x + headW, y + 6);
    y += 12;
  };

  // ═══ THE LINE THE WHOLE PANE EXISTS FOR ═══
  // What this talent is now, and what the point in your hand would make it.
  // GOLD when there is a point to spend and the talent can take one, because
  // that is the only state in which the second number is an OFFER rather than a
  // fact about the future.
  field(
    'Talent level',
    /**
     * THREE STATES, NOT TWO. A talent at rank 0 is OWNED AND UNLEARNED — the
     * class has it in a tree and this character has never put a point in it —
     * and "0 → 1 (of 5)" describes that as though it were ordinary progress.
     * It is the one row on this pane where the `+` does something categorically
     * different: it LEARNS the talent rather than deepening it.
     */
    cell.level < 1
      ? `not learned — one point learns it`
      : cell.level >= cell.maxLevel
        ? `${String(cell.level)}/${String(cell.maxLevel)} — mastered`
        : `${String(cell.level)} ${ARROW} ${String(cell.level + 1)}  (of ${String(cell.maxLevel)})`,
    cell.canSpend ? PALETTE.GOLD : PALETTE.PARCHMENT,
  );

  if (!cell.passive) {
    field('Cost', `${String(cell.cost.ap)} AP`);
    if (cell.cost.resource > 0) field('Resource', `${String(cell.cost.resource)} resolve`);
    field('Range', cell.range >= 2 ? `${String(cell.range)} tiles` : 'melee');
    field('Cooldown', cell.cooldownTurns > 0 ? `${String(cell.cooldownTurns)} turns` : 'none');
  }

  y += 4;
  ctx.font = FONT_BODY;
  ctx.fillStyle = PALETTE.SILVER;
  for (const text of wrap(cell.desc, w)) {
    if (y + 12 > bottom) return;
    ctx.fillText(text, x, y + 6);
    y += 12;
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * AND WHY THE POINT CANNOT GO HERE — ABOVE the next-rank line, deliberately.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The gold line below says what one point WOULD buy. Printing that first and
   * the refusal underneath reads as an offer withdrawn; printing the refusal
   * first reads as a condition on an offer that still stands, which is what
   * this actually is — every one of these three sentences names something the
   * player can go and do.
   *
   * ORANGE, not the missing-asset violet and not the gold: it is the only place
   * on this pane that is a REFUSAL, and it must not be mistaken at a glance for
   * the thing one point buys.
   */
  if (cell.lockedReason !== null) {
    y += 4;
    ctx.fillStyle = PALETTE.ORANGE;
    for (const text of wrap(cell.lockedReason, w)) {
      if (y + 12 > bottom) return;
      ctx.fillText(text, x, y + 6);
      y += 12;
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT THE NEXT RANK WANTS — every clause, met or not.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ═══ THE REFUSAL ABOVE ONLY EXISTS ONCE IT IS TOO LATE ═══
   * `lockedReason` is absent whenever the gate passes, so it taught nobody
   * anything until the day it stopped them. A player at rank 2 with 14 Strength
   * saw a live `+`, spent, and found out at rank 4 that the talent had wanted 18
   * all along — three points into a tree already committed to.
   *
   * `getTalentReqDesc` (ActorTalents.lua:744-798) lists every requirement EVERY
   * time, coloured by whether it is met, and the levelup pane diffs the current
   * list against the next rank's (LevelupDialog.lua:963-970). This is that list.
   *
   * ═══ A MARK AND A COLOUR, NEVER A COLOUR ALONE ═══
   * `·` for met and `!` for not, before the ink is chosen — the rule
   * ui/partypanel.ts states and this file follows everywhere. The unmet ones
   * take ORANGE, the same ink the refusal above uses, because they are the same
   * fact seen earlier.
   */
  if (cell.requires.length > 0) {
    y += 4;
    ctx.font = FONT_META;
    ctx.fillStyle = PALETTE.GREY;
    if (y + 12 <= bottom) {
      ctx.fillText('Needs', x, y + 6);
      y += 12;
    }
    ctx.font = FONT_BODY;
    for (const req of cell.requires) {
      if (y + 12 > bottom) return;
      ctx.fillStyle = req.met ? PALETTE.BONE : PALETTE.ORANGE;
      ctx.fillText(fitText(ctx, `${req.met ? '·' : '!'} ${req.text}`, w), x, y + 6);
      y += 12;
    }
  }

  if (cell.descNext !== null) {
    y += 4;
    // ═══ THE NEXT RANK IN GOLD, WHICH IS WHAT THE HOVER CARD ALREADY USES ═══
    // The one thing on this pane that is not true yet, so it must not read as a
    // fact — upstream keeps its `[-> n]` numbers in their own colour for exactly
    // that reason. GOLD rather than a new colour because `drawHoverCard` paints
    // `nextLines` gold and the two surfaces describe the same talent: a player
    // who learns the colour on one must not have to learn it again on the other.
    //
    // NOT `VIOLET_HI`, which was the first choice and is RESERVED — it IS the
    // missing-asset box, pinned by test/client/assets.test.ts.
    ctx.fillStyle = PALETTE.GOLD;
    for (const text of wrap(`${ARROW} ${cell.descNext}`, w)) {
      if (y + 12 > bottom) return;
      ctx.fillText(text, x, y + 6);
      y += 12;
    }
  }
}

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
    /**
     * SCALED TO THE BOX, NOT CROPPED TO IT.
     *
     * Ability icons are authored 64x64 (ASSETS-REQUIRED.md) and `ICON_PX` is
     * 32, so the old centre-crop took source rect (16, 16, 32, 32) and blitted
     * it 1:1 — the middle quarter of every icon, with the outer ring thrown
     * away. A sword's grip with no blade; a rune with its border cut off.
     *
     * `ui/hotbar.ts` draws the same `icon_active_*` files correctly and says
     * why (`ICON_DRAW_PX`): smoothing is off for the whole buffer, so a 2:1
     * reduction takes every other pixel and stays sharp. Both call sites here
     * pass exactly `ICON_PX`, so this is that same exact halving and not the
     * fractional resample this codebase refuses by name in three places.
     *
     * Upstream does not crop either — `tome/dialogs/elements/TalentTrees.lua:419`
     * is `tal.entity:toScreen(self.tiles, ..., self.icon_size, self.icon_size)`,
     * drawn SCALED to the icon size whatever the source tile is.
     */
    ctx.drawImage(sprite.image, box.x, box.y, box.w, box.h);
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
  // THE HOVER HIGHLIGHT IS THE RING, drawn per icon from `armedId` and
  // `canSpend` — an index cannot name an icon now that categories exist, since
  // index 0 means something different in every one of them.
  _hovered: number | null,
): void {
  const { row, rect } = placed;

  switch (row.kind) {
    case TalentRowKind.Category: {
      /**
       * ═══════════════════════════════════════════════════════════════════
       * ONE CATEGORY: THE HEADING, THEN A ROW OF ICONS, THEN THE RANKS.
       * ═══════════════════════════════════════════════════════════════════
       *
       * The shape the player asked for, taken from ToME's own screen. The
       * heading is GOLD and in the meta face so it names the group without
       * competing with the icons — a header as loud as its contents turns a
       * grouping back into a list.
       */
      ctx.font = FONT_META;
      ctx.textAlign = 'left';
      ctx.fillStyle = PALETTE.GOLD;
      ctx.fillText(fitText(ctx, row.text, rect.w), rect.x, rect.y + 9);

      for (let n = 0; n < placed.cells.length; n += 1) {
        const box = placed.cells[n];
        const cell = row.talents[n];
        if (box === undefined || cell === undefined) continue;

        const armed = armedId === cell.id;
        const atCap = cell.level >= cell.maxLevel;
        const ink = armed ? PALETTE.GOLD : cell.canSpend ? PALETTE.PARCHMENT : PALETTE.SLATE;

        /**
         * THE RING CARRIES THE STATE, AND IT HAS TO SURVIVE GREYSCALE — the rule
         * ui/panel.ts sets for every control in this client. Armed is a thick
         * ring, buyable is a thin one, and a talent you cannot afford is drawn in
         * slate rather than hidden: a control that vanishes when it is refused
         * teaches a player it does not exist.
         */
        ctx.fillStyle = ink;
        drawRowRing(ctx, box, armed ? 2 : 1);

        drawTalentIcon(ctx, sprites, cell.icon, cell.name, box, ink);

        /**
         * ═══════════════════════════════════════════════════════════════════
         * THE TAKE-BACK BADGE — drawn only on what the SERVER says is open.
         * ═══════════════════════════════════════════════════════════════════
         *
         * A filled square with a bar through it, because a bare `-` glyph at
         * ten pixels is indistinguishable from a stray line on the ring. The
         * fill is what makes it read as a control, and it is drawn OVER the
         * icon's own corner so it cannot be mistaken for part of the art.
         *
         * ═══ THE FORM CARRIES IT, NOT THE COLOUR ═══
         * The obvious choice was CRIMSON and it is FORBIDDEN:
         * `test/client/assets.test.ts` reserves it for "hostiles are engaged"
         * and nothing else, and reserves VIOLET_HI for the missing-asset box.
         * The same rule (`ui/partypanel.ts:78-92`) says a state must never be
         * carried by colour ALONE anyway — so this is the only FILLED BLOCK on
         * any icon in the grid, which is what distinguishes it in greyscale, at
         * a glance, and for a player who cannot separate red from green.
         *
         * SLATE, which the grid already uses for "you cannot press this", with a
         * PARCHMENT bar over it. Quiet on purpose: it is the rarest control on
         * the screen and it should not compete with fourteen icons a player is
         * actually choosing between.
         */
        if (cell.canUnlearn) {
          const minus = talentMinusRect(box);
          ctx.fillStyle = PALETTE.SLATE;
          ctx.fillRect(minus.x, minus.y, minus.w, minus.h);
          ctx.fillStyle = PALETTE.PARCHMENT;
          ctx.fillRect(minus.x + 2, minus.y + Math.floor(minus.h / 2), minus.w - 4, 1);
        }

        // `n/max`, centred under the icon — TalentTrees.lua:429-433, with
        // LevelupDialog.lua:537-549's three-way colour split on this palette.
        ctx.font = FONT_LEVEL;
        ctx.textAlign = 'center';
        ctx.fillStyle = atCap ? PALETTE.GOLD : cell.canSpend ? PALETTE.PARCHMENT : PALETTE.GREY_HI;
        ctx.fillText(
          `${cell.level}/${cell.maxLevel}`,
          box.x + ICON_PX / 2,
          box.y + ICON_PX + RANK_H - 2,
        );
        ctx.textAlign = 'left';
      }
      return;
    }

    case TalentRowKind.Points: {
      /**
       * THE COUNT IS ALWAYS DRAWN; THE PLATE IS THE EMPHASIS AND IS NOT.
       * LevelupDialog.lua:757-784 keeps its counters on screen at zero and
       * :690-691 lights a glow only above zero. See `pointsText` for the whole
       * argument and for what it reverses.
       */
      const armedToSpend = row.unspent > 0;
      ctx.font = FONT_META;
      ctx.textAlign = 'left';
      if (armedToSpend) {
        ctx.fillStyle = PALETTE.GOLD;
        ctx.fillRect(rect.x, rect.y + 1, 3, Math.max(1, rect.h - 3));
      }
      ctx.fillStyle = armedToSpend ? PALETTE.GOLD : PALETTE.GREY_HI;
      ctx.fillText(fitText(ctx, row.text, rect.w - 6), rect.x + 6, rect.y + rect.h / 2);
      return;
    }

    case TalentRowKind.Detail:
      // NEVER PLACED. It survives as the CONTENT of the hover card that replaced
      // it — see `talentTipAt`. Drawing it here would put the same prose on
      // screen twice, once under the pointer and once nailed to the panel.
      return;

    case TalentRowKind.Note: {
      ctx.font = FONT_BODY;
      ctx.textAlign = 'left';
      ctx.fillStyle = PALETTE.GREY_HI;
      ctx.fillText(fitText(ctx, row.text, rect.w), rect.x, rect.y + rect.h / 2);
      return;
    }
  }
}

export type TalentPanelDrawOptions = {
  /** How far the category grid is scrolled. See `talentPanelGeometry`. */
  readonly scroll: number;
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
  /**
   * THE TALENT THE DESCRIPTION COLUMN IS ABOUT, or null for the empty state.
   *
   * AN ID AND NOT A CELL, so this panel resolves it against the rows it is
   * drawing THIS FRAME. A caller holding a cell would hold last frame's numbers
   * — and the one number on that pane that must never be stale is the level,
   * which changes on the press this screen exists to make.
   *
   * AN ID THAT IS NO LONGER IN THE ROWS DRAWS THE EMPTY STATE, not a blank one:
   * a class change or a content edit can retire a talent between frames.
   *
   * OPTIONAL, so a caller that predates the column compiles unchanged and gets
   * the pane's "point at a talent" line.
   */
  readonly focusId?: string | null;
  /**
   * THE SIX, COMPOSED, from `ProgressMsg.stats`. Null before the first frame or
   * against a server that does not send them — the column then draws its heading
   * and no rows, which is honest about a build with nothing to show.
   */
  readonly stats?: Readonly<Record<string, number>> | null;
  /**
   * THE SIX AS BOUGHT, from `ProgressMsg.statBase` — class sheet plus points
   * spent, nothing worn. Two things read it and neither can use `stats`:
   *
   *   the CEILING, which upstream binds on the bought value (`no_inc`) so that a
   *     good coat never costs you a point you already own;
   *   and the ROW, which draws `25 (20)` when the two differ — the only way to
   *     tell "I bought this" from "my armour is doing this".
   *
   * Null against a server too old to send it, and then the column behaves
   * exactly as it did before this existed: every `+` live, no brackets.
   */
  readonly statBase?: Readonly<Record<string, number>> | null;
  /** Attribute points in hand. Zero draws no `+` anywhere. */
  readonly unspentStats?: number;
  /**
   * WHICH ATTRIBUTE IS ONE PRESS FROM BEING BOUGHT, or null. The same two-press
   * rule the grid uses and for a sharper reason: there is no `unspend_stat`, so
   * a single-click `+` is a permanent decision one twitch away.
   */
  readonly armedStat?: string | null;
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
  const { scroll } = options;
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

  const geometry = talentPanelGeometry(rect, rows, scroll);
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE GRID IS CLIPPED. Everything else on this panel is not.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A strip half scrolled past the top of the window must be drawn half — and
   * only the grid rows can be in that state, so only they go inside the clip.
   * The points sentence, the stats column and the description pane are outside
   * it and always whole.
   *
   * ToME does the same thing with the same intent: TalentTrees.lua:388 wraps its
   * list in `core.display.glScissor(true, screen_x, screen_y, self.w, self.h)`.
   *
   * ═══ SAVE AND RESTORE ARE A PAIR AND NOTHING RETURNS BETWEEN THEM ═══
   * An unbalanced clip is not a talent-panel bug, it is a bug in every panel
   * drawn AFTER this one in the same frame — the whole HUD inherits a clip
   * rectangle nobody asked for and disappears. So the two calls sit at the same
   * nesting level with a plain `for` between them and no early exit anywhere
   * inside, which is why this loop was not wrapped in a helper that could grow
   * one later.
   */
  ctx.save();
  ctx.beginPath();
  ctx.rect(
    geometry.grid.viewport.x,
    geometry.grid.viewport.y,
    geometry.grid.viewport.w,
    geometry.grid.viewport.h,
  );
  ctx.clip();
  for (const placed of geometry.placed) {
    if (placed.row.kind === TalentRowKind.Category) drawRow(ctx, sprites, placed, armedId, hovered);
  }
  ctx.restore();

  /**
   * ═══ THE BAR, OUTSIDE THE CLIP ═══
   * It is furniture rather than content: it sits in a gutter the grid was never
   * fitted into, it does not scroll with the strips, and clipping it to the
   * window it describes would be circular. `grid.bar` is null unless there is
   * something to scroll, so a list that fits draws nothing at all.
   *
   * ═══ IT REPORTS; IT DOES NOT YET DRAG ═══
   * ToME's is draggable (TalentTrees.lua:72). This one is not, and the wheel is
   * the whole gesture. That is a deliberate stop rather than an unfinished
   * thought: a draggable bar is another hit-testable surface three pixels from a
   * column of icons that spend points irreversibly, and it earns its place only
   * once the wheel proves insufficient. The indicator is the part that was
   * actually missing — without it a player has no way to know the grid continues.
   */
  const { bar, thumb } = geometry.grid;
  if (bar !== null && thumb !== null) {
    ctx.fillStyle = PALETTE.SLATE;
    ctx.fillRect(bar.x, bar.y, bar.w, bar.h);
    ctx.fillStyle = PALETTE.GREY_HI;
    ctx.fillRect(thumb.x, thumb.y, thumb.w, thumb.h);
  }

  // AND EVERYTHING THAT IS NOT A STRIP, OUTSIDE THE CLIP.
  for (const placed of geometry.placed) {
    if (placed.row.kind !== TalentRowKind.Category) drawRow(ctx, sprites, placed, armedId, hovered);
  }

  /**
   * ═══ THE DESCRIPTION COLUMN, RESOLVED AGAINST THIS FRAME'S ROWS ═══
   * `focusId` is an id rather than a cell precisely so this lookup happens here:
   * the level on that pane changes on the press this screen exists to make, and
   * a cell held by the caller would be one frame behind on exactly that number.
   */
  // THE ATTRIBUTE COLUMN, BEFORE THE DESCRIPTION AND AFTER THE GRID. Painted
  // late enough that nothing overdraws it and early enough that the clip is
  // still the panel's.
  if (geometry.stats !== null) {
    drawStats(
      ctx,
      geometry.stats,
      options.stats ?? null,
      Math.max(0, Math.floor(options.unspentStats ?? 0)),
      options.armedStat ?? null,
      options.statBase ?? null,
      // LEVEL 1 IS THE SAFE DEFAULT and it is never reached in practice: the
      // column only draws with a `progress` frame in hand, which carries a real
      // level. If it ever were, it would grey MORE `+` than it should — a
      // refusal the server would have made anyway, rather than a spend it
      // would not.
      Math.max(1, Math.floor(options.level ?? 1)),
    );
  }

  if (geometry.detail !== null) {
    const focus = options.focusId ?? null;
    let cell: TalentCell | null = null;
    if (focus !== null) {
      for (const row of rows) {
        if (row.kind !== TalentRowKind.Category) continue;
        const found = row.talents.find((talent) => talent.id === focus);
        if (found !== undefined) {
          cell = found;
          break;
        }
      }
    }
    drawDetail(ctx, sprites, geometry.detail, cell, talentWrapper());
  }

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
