/**
 * THE ESCAPE MENU: ten entries that all do something, with the Keys screen and
 * the Journal nested inside it.
 *
 * (It said "six entries", and it was six. `rootRows` is the authority and it
 * answers ten — the count in this sentence is prose and nothing checks it, which
 * is precisely why it is worth correcting when the file is open.)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT IS A DOCK PANEL, NOT A MODAL, AND THAT IS THE WHOLE DESIGN
 * ═══════════════════════════════════════════════════════════════════════════
 * ToME's `GameMenu` is a registered dialog: `engine/Game.lua:380-381` calls
 * `d.key:setCurrent()` when one opens, so it SEIZES the keyboard, and the
 * KeyBinder it pushes over itself goes further — `KeyBinder.lua:86` installs a
 * `__DEFAULT` handler that swallows EVERY key until the player presses one. ToME
 * can afford both because ToME is single player and the world is paused while
 * you read.
 *
 * THIS GAME CANNOT, for the reason ui/talents.ts:6-33 and ui/inventory.ts:6-36
 * already state twice: five other people are at the barrier, `isBlocking`
 * (engine/barrier.ts) has no notion of "is reading a menu", and porting that
 * focus capture would mean one player fiddling with their keys holds the whole
 * party until the Bell fires on them. That is not a hypothetical — it shipped
 * once, as a CRITICAL, when the class picker parked a body in the quorum.
 *
 * So this is a PANEL. It swallows no keys, no turn verbs and no hotbar slots; a
 * player reading it can still walk, still commit, still hold, still press 1-4;
 * and THE SERVER IS NEVER TOLD IT IS OPEN. A player who reads instead of acting
 * is exactly a player who is thinking, and the Warrant Clock auto-passes them
 * after the Bell like anyone else.
 *
 * That single decision is why `escapeMenuRect` takes a BAND rather than a
 * viewport — `charSheetRect` is the model it copies. Clamped between `top` and
 * `bottom`, the panel can never come to rest over the hotbar, the resource strip
 * or the prose lines, so every control the player might reach for stays visible
 * and pressable underneath it. IT DRAWS NO SCRIM: that is not an omission, it is
 * the panel-not-modal decision made visible.
 *
 * THE ONE THING THAT IS BOUNDED RATHER THAN ABSENT is the key capture, and its
 * bound is ONE PRESS. `applyCapture` below is a pure state machine in the exact
 * shape of ui/talents.ts:366-369's `pressSpend`: a press on a key column ARMS,
 * the very next keydown is consumed and DISARMS. There is no state in which the
 * keyboard is held for an unbounded time, which is what makes the barrier
 * question not arise at all.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SIX ENTRIES, ALL SIX REAL, AND TEN OF ToME'S ARE REFUSED BY NAME
 * ═══════════════════════════════════════════════════════════════════════════
 * ToME's own list is `Game.lua:2301-2315`: resume, achievements, lore,
 * ingredients, highscores, inventory, character sheet, keybinds, game options,
 * video, sound, save, quit, exit. Ours keeps four of those and adds one:
 *
 *   RESUME            GameMenu.lua:52 — `unregisterDialog(self)`. A surface that
 *                     changed what Escape means owes the player a visible,
 *                     clickable way out, and it is the only row a pointer-only
 *                     player can always rely on.
 *   KEY BINDINGS      GameMenu.lua:53-57. The nested screen below.
 *   CHARACTER SHEET   Game.lua:2308 is `key:triggerVirtual("SHOW_CHARACTER_SHEET")`
 *   TALENTS           — a LAUNCHER, not a second sheet. Ours emits the same
 *   INVENTORY         `UiCommand` the key emits (Game.lua:2307 for inventory),
 *                     so main.ts's existing toggle runs and this file
 *                     reimplements nothing.
 *   LEAVE PARTY       ours. `PartyAction.Leave` is a real wire verb, already
 *                     reachable by `/leave` and by right-clicking your own
 *                     token, and this is the third door onto it.
 *
 * REFUSED, EACH NAMING A SYSTEM THAT DOES NOT EXIST HERE: Save Game
 * (GameMenu.lua:117 — the game autosaves and `save` is not in the client's wire
 * vocabulary at all), Main Menu and Exit Game (GameMenu.lua:118-119 — this is an
 * Activity inside a voice channel; there is nowhere to exit TO and no disconnect
 * verb), Audio Options (GameMenu.lua:78-82 — there is no sound in this project),
 * Video Options and Display Resolution (GameMenu.lua:63-72 — render/canvas.ts
 * owns the integer scale and the canvas sizes itself to the iframe), Show
 * Achievements / Known Lore / Ingredients (Game.lua:2303-2305 — none of those
 * three systems exists), Game Options (Game.lua:2310 — its four tabs are ~45
 * entries of graphics, fonts, tactical overlays and Steam presence, essentially
 * none of which has a referent here) and Developer Mode (GameMenu.lua:93-116 —
 * our ops surface is a separate 127.0.0.1:3001 listener and a client row
 * reaching it would cross the one trust boundary in the codebase).
 *
 * AND HIGHSCORES IS THE DEMONSTRATION. `Game.lua:2306` asks for it,
 * `GameMenu.lua:83-87` has it COMMENTED OUT, and the builder at
 * `GameMenu.lua:125-133` is `local a = default_actions[act]; if a then ... end`
 * — a string looked up in a table, silently dropped when it misses. A dead entry
 * has shipped in the file we are porting from. THAT IS WHY THE ROWS HERE ARE A
 * TYPED UNION WITH THE EFFECT ON THE RECORD (`MenuEffect`, the shape
 * src/client/input/keymap.ts's `ActionEffect` already uses): an entry that names
 * nothing is a compile error rather than a row that quietly is not there.
 *
 * A DISABLED ROW IS DRAWN GREYED, NEVER DROPPED — ui/contextmenu.ts:94-102's
 * rule verbatim: a menu whose SHAPE changes with state moves the row you were
 * reaching for, and a player who cannot see LEAVE PARTY at all learns nothing
 * about why they cannot use it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NESTING IS A MODE FIELD ON ONE SURFACE, NOT TWO PANELS
 * ═══════════════════════════════════════════════════════════════════════════
 * `MenuScreen` is the tab pattern of ui/inventory.ts:309-318: ONE rect, ONE
 * geometry that switches on the rows it is given, ONE hit test. Two
 * independently-positioned panels would reproduce the three-way overlap problem
 * main.ts already spends forty lines guarding, and would need a second answer to
 * "which one does Escape close".
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE KEYS SCREEN PAGES. IT DOES NOT SCROLL, AND IT IS NOT TWO COLUMNS
 * ═══════════════════════════════════════════════════════════════════════════
 * Twenty-six actions at the house ROW_H of 12, plus five group headings at 18,
 * is 402 pixels of rows, and the panel is capped at 252 like ui/talents.ts:188.
 * Something has to give, and it is not scrolling: ui/charsheet.ts:98-111,
 * ui/talents.ts:84-92 and ui/inventory.ts:89-107 each refuse a second scrolling
 * surface in writing, the Case Log's scroll is closure-private and indexed by
 * ENTRY rather than by row, and there is no scrollbar sprite in the manifest.
 *
 * TWO COLUMNS WERE TRIED ON PAPER AND REFUSED, WITH ARITHMETIC. A key row is a
 * name, two key columns and two controls; the columns and controls are 153
 * pixels of that and cannot shrink (a 3-character button label needs 24 pixels
 * before `fitText` starts eating it). Two columns inside a 344-pixel inner width
 * leave 167 for a whole key row and 14 for its NAME — "Move nor…" — so the
 * second column would cost the reader the one thing the row is FOR. So: ONE
 * column, and PAGES.
 *
 * `place` below is nonetheless ui/charsheet.ts:842-886's function, ported with
 * its orphan rule intact — A HEADING NEVER SITS ALONE AT THE FOOT OF A PAGE,
 * because the reader takes the rows UNDER a heading as belonging to it and an
 * orphan says the next block is unlabelled. The only change is that it breaks to
 * the next PAGE where the sheet breaks to the next COLUMN.
 *
 * AND THE PAGER IS WORDS AND A COUNT, NEVER A BAR — ui/caselog.ts:464-478's rule
 * for the one other surface in this client that has quietly stopped showing
 * everything: "13–26 of 26", drawn beside two plain buttons.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ZERO NEW SPRITE IDS. NOT ONE ASSET LITERAL IN THIS FILE
 * ═══════════════════════════════════════════════════════════════════════════
 * There is no gear, no keyboard, no settings and no scrollbar in the 111-asset
 * manifest, and client/public/assets/ is gitignored wholesale, so an invented id
 * renders as the LOUD violet fallback box on every clone. Art is reached ONLY
 * through `drawPanel` / `drawHeader` / `drawButton` from ui/panel.ts — the same
 * discipline ui/talents.ts:94-108 already keeps — and everything else is
 * `fillRect`, `fillText` and the `[X]` bracketed-letter grammar
 * ui/charsheet.ts:214-229 took from ToME's own "Manage [I]nventory" button.
 * Neither PALETTE.CRIMSON (it means "hostiles are engaged") nor PALETTE.VIOLET_HI
 * (it IS the missing-asset box) is spent here, and every state carries a SHAPE or
 * a WORD as well as a colour — ui/partypanel.ts:78-92.
 *
 * It draws into the BACKBUFFER at logical scale like every other ui/ module —
 * see the long note at the top of render/canvas.ts.
 */

import { PartyAction } from '../../shared/protocol.ts';
import type { LoreView } from '../../shared/protocol.ts';
import { PALETTE } from '../render/canvas.ts';
import { UI_SCALE_MAX, UI_SCALE_MIN } from '../../shared/version.ts';
import {
  ACTIONS,
  actionById,
  canDeliver,
  clearBinding,
  conflictsFor,
  KEY_GROUPS,
  labelFor,
  labelForBinding,
  setBinding,
  SLOTS_PER_ACTION,
} from '../input/keymap.ts';
import { UiCommand } from '../input/keys.ts';
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
import type { ActionDef, Binding, KeyGroup, Keymap, KeyRemap } from '../input/keymap.ts';
import type { SpriteSource } from '../render/assets.ts';
import type { PanelRect } from './panel.ts';

// ---------------------------------------------------------------------------
// Geometry constants. See the header before changing any of them.
// ---------------------------------------------------------------------------

/** Chrome lost on each side. Mirrors `panelInner`'s inset, as ui/tooltip.ts does. */
const INSET = PANEL_PAD + 3;

/**
 * Advance of one glyph in the 10px monospace this file draws with. The same six
 * pixels ui/charsheet.ts:157-162, ui/tooltip.ts and ui/contextmenu.ts use, and
 * for the same reason: it decides how big a BOX is and nothing else. Every
 * string still goes through `fitText` against the real width at paint time.
 */
const CHAR_W = 6;

/** One key row. 10px glyphs with 2px of leading, matching the Case Log. */
const ROW_H = 12;
/**
 * A LOCKED key row, which is ten pixels taller because it carries a second line.
 *
 * ═══ THE REASON DOES NOT FIT BESIDE THE NAME, AND IT IS NOT OPTIONAL ═══
 * A row is 344 pixels wide at the panel's preferred size, of which 153 are the
 * columns, so the annotation beside a name has about seventeen characters — and
 * "the digit is painted on the slot" is thirty-one. Truncating it would leave
 * "LOCKED · the dig…", which tells the player they cannot do something and then
 * eats the half of the sentence that says why. Five rows in twenty-six are
 * locked, so the whole cost of doing it properly is fifty pixels.
 */
const LOCKED_ROW_H = ROW_H + 10;
/** A root entry. Two pixels taller than a key row, so it reads as a target. */
const ENTRY_H = 14;
/** A group heading: the same line, plus air above it and a rule under it. */
const SECTION_H = 18;
/** The bottom strip: RESET ALL, BACK and the pager. */
const FOOTER_H = 14;
/** The one line above the footer that says what just happened. See `statusRow`. */
const STATUS_H = 12;
/** A sentence about the panel itself — what was dropped. */
const NOTE_ROW_H = 12;

/**
 * A key column. Four characters ("Num8", "PgDn") plus the button's own 6 pixels
 * of padding, rounded up so a five-character label is not immediately ellipsised.
 */
const KEY_COL_W = 46;
/** The two per-row controls. Three characters — `[X]`, `[D]` — plus the padding. */
const CTRL_W = 26;
/** Air between two controls, so neither swallows the other's click. */
const CTRL_GAP = 3;
/** A control's height. One pixel of air top and bottom inside a 12px row. */
const BTN_H = ROW_H - 1;

/** The narrowest a name can be and still say anything at all. */
const NAME_MIN_W = 52;
/** Everything to the right of the name on a key row. See the header's arithmetic. */
const CONTROLS_W = KEY_COL_W * 2 + CTRL_W * 2 + CTRL_GAP * 3;
/** The narrowest a key row can be. Gates `PANEL_MIN_W`. */
const KEY_ROW_MIN_W = NAME_MIN_W + CTRL_GAP + CONTROLS_W;

/** The footer's own controls. */
const RESET_ALL_W = 62;
const BACK_W = 40;
const PAGE_BTN_W = 18;

/**
 * ══════════════════════════════════════════════════════════════════════════
 * THE UI SIZE ROW'S OWN FURNITURE: two arrows and the number between them.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * NARROWER THAN `CTRL_W`, which is the Keys screen's `[X]`/`[D]` button and
 * holds three glyphs. These hold one, and they sit on a root row that is only
 * `ENTRY_H` tall with a label already in it — so they take the width of a
 * button rather than the width of a label.
 *
 * `STEP_VALUE_W` FITS `100%` AT `CHAR_W` WITH A CHARACTER TO SPARE: the widest
 * value this can print is four characters, and the box is centred text, so a
 * fifth would simply be clipped by `fitText` rather than pushing an arrow.
 */
const STEP_BTN_W = 12;
const STEP_GAP = 3;
const STEP_VALUE_W = CHAR_W * 5;

/** The close control, top-right of the header strip. Square, so it is a target. */
const CLOSE_PX = 13;

/** Preferred and minimum size of the panel itself. */
const PANEL_W = 360;
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE KEYS SCREEN GETS THE WINDOW. THE ROOT MENU DOES NOT WANT IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `PANEL_W`/`PANEL_MAX_H` are right for the root menu, which is six entries and
 * a title -- growing THAT with the monitor would give a 1280 screen a 560-wide
 * box holding six words and a lot of air, which is worse than the compact panel
 * and not what "use the space" means.
 *
 * The Keys screen is the opposite case and had the opposite problem. It is
 * TWENTY-NINE actions in two columns and it paginates, and at a fixed 360x252 it
 * showed `1–12 of 29` on EVERY viewport -- so a player on a 1280x720 monitor
 * paged three times through their own keybinds with two thirds of the screen
 * empty behind the panel. The pager was doing its job; it was being asked the
 * question on a panel that had decided not to grow.
 *
 * ═══ WHY A SEPARATE SIZE AND NOT ONE THAT GROWS FOR BOTH ═══
 * A panel is sized for its CONTENT. These are two contents that happen to share
 * a frame, and `escapeMenuRows` already treats them as different screens
 * everywhere else. The caps are what stop the keys screen becoming a wall: past
 * them, extra window buys nothing because there are only 29 rows to show.
 */
const KEYS_FILL_W = 0.62;
/**
 * ═══ 0.92 -> 0.96 AND 640 -> 704, BECAUSE THE TABLE GREW AND MISSED BY TWO ═══
 * The bar gained talent slots 7, 8 and 9, so `ACTIONS` went 31 -> 34 and, since
 * every hotbar digit is LOCKED, three of the new rows are `LOCKED_ROW_H` rather
 * than `ROW_H`. The table's content height:
 *
 *   34 rows x 12  +  10 locked x 10 extra  +  5 group headings x 18  =  598
 *   chrome = HEADER_H 24 + INSET 8 x2 + STATUS_H 12 + FOOTER_H 14    =   66
 *                                                            panel  =  664
 *
 * At 1280x720 the old pair offered `min(0.92 x 720, 640)` = 640, and before the
 * cap even applied the FILL was 662 — TWO PIXELS under. The keys screen started
 * showing `1–30 of 34`, breaking the one property this sizing exists for: on a
 * normal monitor you read your keybinds, you do not page through them.
 *
 * 0.96 x 720 = 691, so the content band is 625 against the 598 it needs — a bit
 * over two rows of headroom, and the max is raised past it so the fill is what
 * decides at 720p rather than the cap.
 *
 * ═══ THE NINETY PIXELS HAVE SINCE BEEN RETURNED, AND THIS SAID OTHERWISE ═══
 * This paragraph used to end: *"Doing that returns ninety pixels and this pair
 * could go back down; it is a layout change rather than a sizing one, so it is
 * not smuggled in here."* It was done — `sharedLockReason` says the hotbar's
 * lock reason ONCE, at the group, instead of on nine rows each paying
 * `LOCKED_ROW_H`'s ten extra pixels — so the note was describing a past state and
 * pointing the next reader at ninety pixels that are no longer there to find.
 *
 * ═══ WHERE THE BUDGET ACTUALLY STANDS, MEASURED ═══
 * This said `ACTIONS` WAS 36 (rest and auto-explore joined it); it went to 34
 * when the two zoom rows left and to 35 when the Journal joined. Re-measured at
 * 35: 1280x720 still fits on ONE PAGE (`35 keys`, no pager), which is the
 * property this sizing exists for. At 1024x600 it pages at two (`1–29 of 35`),
 * and no cap can fix that: the panel is bound by the BAND between the top HUD
 * and the hotbar — 518 pixels there — rather than by `KEYS_MAX_H`. Raising the
 * cap would move nothing.
 *
 * So the next action that joins the table costs a row and nothing is being held
 * in reserve for it. If 1280x720 ever starts paging, the fix is fewer rows or a
 * second screen, not a bigger number here.
 */
const KEYS_FILL_H = 0.96;
const KEYS_MAX_W = 560;
const KEYS_MAX_H = 704;
const PANEL_MIN_W = KEY_ROW_MIN_W + INSET * 2;
/** The same cap ui/talents.ts:188 uses. A taller panel is a modal in a costume. */
const PANEL_MAX_H = 252;
/**
 * A panel that cannot hold its header, its status line, its footer, ONE group
 * heading and ONE key row is not worth drawing.
 *
 * One row rather than twenty-six, deliberately: the pager below removes rows
 * from the tail and says so in words, so a short band gives a truthful partial
 * screen. Refusing to open until everything fits would leave a player pressing
 * Escape and seeing nothing at all — which is the one key that must always
 * visibly work.
 */
const PANEL_MIN_H = HEADER_H + INSET * 2 + STATUS_H + FOOTER_H + SECTION_H + ROW_H;
/** Air between the panel and the edges of the band it is clamped into. */
const PANEL_MARGIN = 6;

const FONT_NAME = 'bold 10px ui-monospace, Consolas, monospace';
const FONT_BODY = '10px ui-monospace, Consolas, monospace';
const FONT_META = 'bold 10px ui-monospace, Consolas, monospace';

/** ToME calls these two screens exactly this (GameMenu.lua:31, KeyBinder.lua:34). */
const TITLE_ROOT = 'GAME MENU';
const TITLE_KEYS = 'KEY BINDINGS';
/**
 * THE THIRD SCREEN HAS A NAME OF ITS OWN NOW, AND IT USED TO WEAR THE ROOT'S.
 *
 * `drawHeader` asked one question — "is this the Keys screen?" — so the archive
 * opened under the title `GAME MENU`, which named the surface rather than the
 * screen. That was survivable while the screen was one list of found paper; it
 * is not survivable for a screen a KEY opens directly, because a player who
 * presses `j` and reads `GAME MENU` has been told their key did the wrong thing.
 *
 * `JOURNAL`, NOT `QUEST LOG`. Upstream titles its dialog *"Quest Log for
 * "..actor.name* (`engine/dialogs/ShowQuests.lua:32`) and that is the right word
 * for a dialog holding ONLY quests. Ours holds quests AND the notes, which is
 * the author's own word for it: *"case notes should actually be 'Journal' which
 * will serve as a quest log/ similar"*. The name is not per-character either —
 * see `character-names-are-discord`.
 */
const TITLE_JOURNAL = 'JOURNAL';

/** The two per-row controls, in the bracketed-letter grammar. */
const CLEAR_LABEL = '[X]';
const RESET_LABEL = '[D]';
/** A key column with a capture armed on it. A different GLYPH, not just a colour. */
const ARMED_LABEL = '[?]';
/** The footer's controls. */
const RESET_ALL_LABEL = 'RESET ALL';
const BACK_LABEL = 'BACK';
/**
 * ═══ THE TWO ARROWS ARE DRAWN, NOT TYPED, AND THAT IS WHY THIS IS A NUMBER ═══
 *
 * They were `'◀'` and `'▶'` handed to `drawButton`, and `drawButton` fits its
 * label to `rect.w - 6` — six pixels on a 12-wide plate. Neither triangle is in
 * `ui-monospace`, so the browser falls back to whatever proportional face has
 * them and the glyph measured 8.61px: it did not fit, `fitText` could not
 * shorten one character, and what was drawn was `◀…` at 14.11px centred in a
 * 12px box — the triangle hanging outside the border with the ellipsis inside
 * it, on every window where the row is live.
 *
 * `fitText` no longer widens a one-glyph label (ui/panel.ts), which is the
 * general half of that bug. This is the specific half: a control whose size is
 * fixed in this file must not depend on which font a machine happens to have.
 * `drawCog` in ui/caselog.ts made the same choice for the same reason.
 *
 * FIVE BY NINE INSIDE A 12x11 PLATE: a pixel of air either side of the point,
 * and an odd height so the tip lands on a whole pixel rather than between two.
 */
const STEP_ARROW_W = 5;
const STEP_ARROW_H = 9;

const PREV_LABEL = '<';
const NEXT_LABEL = '>';
/** The marker on the row the pointer is over. A shape, so hover survives greyscale. */
const HOVER_MARK = '▸';
/** What a locked row says before its reason. A WORD, per the header. */
export const LOCKED_WORD = 'LOCKED';

/**
 * THE ARMED PROMPT, AND IT STATES BOTH OUTS.
 *
 * KeyBinder.lua:82 titles its capture dialog "Press a key (escape to cancel,
 * backspace to remove) for: <name>", and both halves of that parenthesis are
 * load-bearing: Escape is the only reason upstream's binder is not self-bricking
 * (KeyBinder.lua:98 compares the RAW sym, outside the virtual system), and
 * Backspace is the only way to say "nothing at all" (:95-97).
 */
const ARMED_PROMPT = 'press a key — Escape cancels, Backspace clears';
/** Decision (h)(3): the anonymous player is told while they are doing it. */
const NOT_SAVED = 'not saved: this session is not signed in';
/** The quiet default. It is an instruction, not furniture — see `statusRow`. */
const KEYS_HINT = 'press a key column to rebind it';

// ---------------------------------------------------------------------------
// The three screens. It said TWO, and the Journal is the third — it existed as
// `Notes` when that heading was written, which is how a count in a heading goes
// stale without anything moving.
// ---------------------------------------------------------------------------

/**
 * Which screen the ONE surface is showing.
 *
 * A const object plus a derived type rather than an `enum`: `erasableSyntaxOnly`
 * is on and an enum emits runtime code the type-stripping loader refuses. The
 * shape is ui/inventory.ts:309-318's `InventoryTab`, for the reason the header
 * gives: one rect, one geometry, one hit test.
 */
export const MenuScreen = {
  /** The six entries. */
  Root: 'root',
  /** Every action, its two keys, and the controls that change them. */
  Keys: 'keys',
  /**
   * THE JOURNAL: what this character has AGREED TO DO, and what they have READ.
   *
   * ═══ IT WAS `Notes`, AND THE SCREEN GREW A SECOND HALF ═══
   * Ruled: *"case notes should actually be 'Journal' which will serve as a quest
   * log/ similar"*. The old member held one list — the port of `ShowLore.lua` —
   * and that list is still here, under a `NOTES` heading and unchanged. What is
   * new is a `QUESTS` heading above it, which is the SHAPE of
   * `engine/dialogs/ShowQuests.lua` on this surface.
   *
   * A SCREEN ON THIS SURFACE AND NOT A PANEL OF ITS OWN, which is upstream's
   * own placement for the notes half: `learnLore` tells the player *"You can
   * read all your collected lore in the game menu, by pressing Escape"*. It is
   * NOT upstream's placement for the quests half — `SHOW_QUESTS`
   * (`modules/tome/class/Game.lua:2234`) registers a second dialog — and that is
   * a deliberate divergence: one rect, one geometry, one hit test is this
   * surface's own rule, and it is the reason `Keys` is here rather than in a
   * modal of its own.
   *
   * THE STRING MOVED AND NOTHING PERSISTS IT. `menuScreen` is client module
   * state that resets on every open (`openMenu`), so this value has never
   * reached a save file or the wire. The stored KEYBIND id is a different thing
   * and it did not move: `show_journal` is a new action, and `toggle_log`'s note
   * in keymap.ts records the rule both follow.
   */
  Journal: 'journal',
} as const;
export type MenuScreen = (typeof MenuScreen)[keyof typeof MenuScreen];

/**
 * THE TITLE IN THE HEADER, FOR EVERY SCREEN, IN ONE PLACE.
 *
 * It was a ternary inside `drawEscapeMenu` that asked about ONE of the three
 * screens, so the third fell through to the root's title and the archive opened
 * under the word `GAME MENU`. A `switch` on the union is what makes a fourth
 * screen a compile error here instead of a silently mislabelled panel.
 *
 * EXPORTED so the test can read the title without a canvas: what a header SAYS
 * is a fact about the screen, and asserting it through a stubbed `fillText` call
 * order would be testing the painter instead.
 */
export function menuTitle(screen: MenuScreen): string {
  switch (screen) {
    case MenuScreen.Keys:
      return TITLE_KEYS;
    case MenuScreen.Journal:
      return TITLE_JOURNAL;
    case MenuScreen.Root:
      return TITLE_ROOT;
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE JOURNAL'S TWO HEADINGS, AS THE ONLY TWO STRINGS THAT MAY BE ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `MenuRow`'s `Section` used to carry a `KeyGroup` and nothing else, because the
 * Keys screen was the only screen with sections in it. Widening that field to
 * `string` would have let any row anywhere become a heading by typo; naming the
 * two members keeps the property the narrow type had — a heading is one of a
 * closed set, and a third one is a deliberate edit here.
 *
 * ORDER: QUESTS FIRST. Upstream's journal IS the quest log
 * (`engine/dialogs/ShowQuests.lua`) and the lore is a separate dialog
 * (`modules/tome/dialogs/ShowLore.lua`), so the half that carries the name goes
 * at the top. It is also the half that answers the question a player opens this
 * screen mid-fight to ask.
 */
export const JournalSection = {
  Quests: 'QUESTS',
  Notes: 'NOTES',
} as const;
export type JournalSection = (typeof JournalSection)[keyof typeof JournalSection];

/**
 * ONE QUEST, AS THIS SCREEN NEEDS IT.
 *
 * ═══ THE SHAPE IS `ShowQuests.lua:89`'S LIST ROW, MINUS WHAT WE CANNOT DRAW ═══
 * Upstream builds `{ name=q.name, status=q.status_text[q.status], desc=..., ...
 * }` per quest and puts the first two in two columns (`:38-41`, "Quest" and
 * "Status"). Those two are here. `desc` is NOT: upstream opens it in a second
 * pane beside the list, and this surface is one narrow column with no scroll —
 * the notes half already unfolds in place for that reason, and a fold over
 * paper nothing can write yet would be a control with nothing behind it.
 *
 * `status` IS A WORD, ALREADY CHOSEN BY WHOEVER PRODUCES THE LIST. Upstream's
 * four are `active`, `completed`, `done` and `failed`
 * (`engine/Quest.lua:31-36`), and a union here would be this client inventing a
 * vocabulary for a server feature that does not exist yet — the brief design
 * names its states `offered`/`open`/`closed`/`failed`, which is a reconciliation
 * for the lane that ships them and not for this one.
 *
 * `id` IS CARRIED AND NOT DRAWN, so a later fold has a key to open by and so a
 * list can be keyed without one being invented at that point.
 */
export type JournalQuestView = {
  readonly id: string;
  readonly name: string;
  readonly status: string;
};

/**
 * WHAT AN ENTRY DOES WHEN IT IS PRESSED.
 *
 * ═══ THE EFFECT IS ON THE RECORD, WHICH IS THE WHOLE POINT ═══
 * `GameMenu.lua:125-133` builds its list by looking a STRING up in a table and
 * dropping what it cannot resolve, which is how upstream ships a dead
 * "highscores" row. Carrying the effect on the row makes the caller's switch
 * TOTAL: an entry that names nothing does not compile. It is exactly the shape
 * src/client/input/keymap.ts's `ActionEffect` uses, and for the same reason.
 *
 * `ui` CARRIES THE WIRE-FREE VERB THE KEYBOARD ALREADY EMITS, so the row runs
 * main.ts's EXISTING toggle rather than a second copy of it — which is what
 * `Game.lua:2307-2308` does with `key:triggerVirtual("SHOW_INVENTORY")`.
 * `party` carries `PartyAction`, the wire's own verb, exactly as
 * ui/contextmenu.ts:92 does.
 */
export type MenuEffect =
  | { readonly kind: 'resume' }
  | { readonly kind: 'keys' }
  /** Open the Journal. See `MenuScreen.Journal`. */
  | { readonly kind: 'journal' }
  /**
   * READ ONE, or fold it away again if it is the one already open.
   *
   * The id rides the effect for `MenuItem.groundId`'s reason: one verb with a
   * payload keeps the caller's switch total, where one effect per note would
   * make the union grow with the content. (It named `MenuItem.topic` until the
   * townsfolk questions moved into the conversation window and that field went
   * with them; the argument is the same one, and `groundId` still makes it.)
   */
  | { readonly kind: 'note'; readonly id: string }
  /**
   * PUT THIS CHARACTER DOWN AND GO BACK TO THE LIST.
   *
   * NOT A `ui` COMMAND, and the distinction is load-bearing: every `UiCommand`
   * is a panel this client opens over a live world, and this one ENDS the world.
   * Folding it in would put "leave the game" in the same bucket as "show the
   * bag", and the first thing to go wrong would be a keybinding for it.
   *
   * DELIBERATELY UNBINDABLE FOR THE SAME REASON. There is no `labelFor` on its
   * row, so it has no key and cannot get one — a stray press that dropped
   * somebody out of a fight and back to a menu is not a mistake this client
   * should make available.
   */
  | { readonly kind: 'leave-character' }
  | { readonly kind: 'ui'; readonly command: UiCommand }
  /**
   * ══════════════════════════════════════════════════════════════════════════
   * STEP THE INTERFACE SIZE. Asked for, and it had no route at all.
   * ══════════════════════════════════════════════════════════════════════════
   * *"we also need to include an option in the settings for UI scaling to lower
   * or increase it."*
   *
   * `hudScale` was computed by `viewLayout` from the device pixel ratio and
   * `HUD_MAX_*`, and a player who wanted the interface bigger had no way to say
   * so. Upstream exposes the equivalent on a settings screen in two places
   * (GraphicMode.lua:139, VideoOptions.lua:77).
   *
   * ═══ `delta` IS THE WHOLE VOCABULARY OF THE ROW ═══
   * -1 and +1 are the two ARROWS: one step that way, clamped by the renderer,
   * and the arrow at the end of the range is drawn greyed and answers no click.
   * Asked for in those words: *"the \"UI Size\" button should be arrows that
   * change the scaling percentage, not just smaller, larger, etc."*
   *
   * 0 IS THE ROW ITSELF, AND IT CYCLES. That is what the row did before the
   * arrows existed, and it is kept because it is the KEYBOARD's copy of them:
   * `pressMenuSelection` has exactly one act per row, so a row whose Enter
   * clamped at the top would strand a keyboard-only player at LARGEST with no
   * way back down. Left/Right on the lit row step like the arrows; Enter wraps.
   *
   * IT LEAVES THE MENU OPEN, unlike every other row here. The whole point is to
   * look at the result and press again.
   *
   * THERE WAS A `zoom` ROW ABOVE THIS ONE and it is gone — *"remove the (zoom)
   * option"*. It moved the MAP's magnification, which is a different factor
   * (test/client/hudscale.test.ts is the record of splitting them), and nothing
   * here inherits it: this row must never reach `scale`.
   */
  | { readonly kind: 'ui-scale'; readonly delta: number }
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * PUT THE PANELS BACK — `Minimalist.lua:354-359`'s `resetPlaces`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Four panels can be dragged and there was no way to undo it. A panel parked
   * somewhere awkward is a nuisance; one dragged to the far edge on a window
   * that then SHRANK is a panel whose close control the player has to fish for
   * — `moveIntoBand` clamps it back into view, so nothing is ever truly lost,
   * but "drag it back by hand, four times" is not a recovery story.
   *
   * ═══ ONE PRESS, NO CONFIRMATION, AND THAT IS THE RULE FOR A HATCH ═══
   * The Keys screen's RESET ALL is argued the same way in this file: a recovery
   * control *"must never acquire a keyboard-only path or a confirmation step
   * that needs one — the player who needs them may have no working key at all"*.
   * Undoing this is four drags, which is exactly what the player was already
   * doing.
   */
  | { readonly kind: 'reset-panels' }
  | { readonly kind: 'party'; readonly action: PartyAction };

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** The six kinds of line the surface can hold, across all three screens. */
export const MenuRowKind = {
  /** A root entry: a label, the key that also does it, and an effect. */
  Entry: 'entry',
  /** A heading on the Keys or Journal screen, with a rule under it. Never a target. */
  Section: 'section',
  /** One action: name, two key columns, and the controls that change them. */
  Action: 'action',
  /** The one line above the footer. Armed prompt, last answer, or the warning. */
  Status: 'status',
  /** The bottom strip: RESET ALL, BACK, and the pager. Keys screen only. */
  Footer: 'footer',
  /** A sentence about the panel itself — what was dropped. */
  Note: 'note',
} as const;
export type MenuRowKind = (typeof MenuRowKind)[keyof typeof MenuRowKind];

/**
 * How loud the status line is. NEVER COLOUR ALONE — each tone also carries a
 * MARKER glyph (`markerFor`), so the three survive greyscale.
 */
export const MenuTone = {
  /** The standing instruction. */
  Quiet: 'quiet',
  /** A refusal, a conflict, or "this will not be saved". */
  Warn: 'warn',
  /** A capture is armed and the next key lands somewhere. */
  Armed: 'armed',
} as const;
export type MenuTone = (typeof MenuTone)[keyof typeof MenuTone];

export type MenuRow =
  | {
      readonly kind: typeof MenuRowKind.Entry;
      /** Position in the root list. Carried so a hit names a row, not a pixel. */
      readonly index: number;
      readonly effect: MenuEffect;
      readonly label: string;
      /**
       * The key that ALSO does this, read live off the keymap — never a
       * hard-coded letter, which is a lie the moment somebody rebinds.
       */
      readonly keyLabel: string;
      /** False draws the row greyed and makes the hit test answer null. */
      readonly enabled: boolean;
      /** Why it is greyed, in words. Null when it is not. */
      readonly reason: string | null;
      /**
       * ═════════════════════════════════════════════════════════════════════
       * TWO ARROWS AND A READOUT, ON THE RIGHT OF THIS ROW. Absent on all but
       * one of them.
       * ═════════════════════════════════════════════════════════════════════
       * The UI SIZE row is the only entry that carries a VALUE the player
       * moves rather than a screen they open, so it is the only one with
       * controls inside it. Declared on the row rather than inferred from the
       * effect kind because the painter, `place` and the hit test all have to
       * agree about whether this row has buttons in it, and three readings of
       * one fact is how a button gets drawn and then ignored.
       *
       * `less` AND `more` ARE THE ENDS OF THE RANGE. False draws that arrow
       * greyed and makes the hit test answer null for it — the same rule
       * `enabled` keeps for the row, one level down, so "unpressable" stays a
       * property of the geometry rather than a check somebody can forget.
       *
       * NO BOXES AT ALL ON A GREYED ROW. `place` skips them when `enabled` is
       * false, so a window with no room for a second factor has a row that
       * says so and nothing inside it to press.
       */
      readonly steppers?: {
        readonly less: boolean;
        readonly more: boolean;
        /** Drawn between the arrows. "125%", already formatted. */
        readonly value: string;
      };
    }
  /**
   * A HEADING. `KeyGroup` on the Keys screen, `JournalSection` on the Journal —
   * two closed sets and not `string`, so a heading stays something a reader can
   * enumerate rather than anything a typo can produce. See `JournalSection`.
   */
  | { readonly kind: typeof MenuRowKind.Section; readonly label: KeyGroup | JournalSection }
  | {
      readonly kind: typeof MenuRowKind.Action;
      readonly actionId: string;
      readonly name: string;
      /**
       * The two slots AS A PLAYER READS THEM, '--' for empty — ToME's b1/b2
       * columns (KeyBinder.lua:218-219), whose `formatKeyString` opens with
       * `if not ks then return "--" end` (KeyBind.lua:158-160). NEVER the stored
       * form: a row reading `key:w` would be leaking a serialisation.
       */
      readonly slots: readonly [string, string];
      /**
       * The PERMANENT FLOOR, as one string, or ''.
       *
       * A player who rewrote `w` must be able to SEE that the numpad still
       * moves them, or they will report the rebind as having broken movement.
       * `bindingsFor` composes the same list for the dispatcher.
       *
       * IT USED TO SAY "the arrows and the numpad". The arrows left movement's
       * floor with the WASD ruling — they select rather than walk now — so this
       * string names the numpad alone, and on a diagonal it names the numpad and
       * nothing else at all.
       */
      readonly fixed: string;
      /** True for `cancel` and the four hotbar digits. See `lockReason`. */
      readonly locked: boolean;
      /** Why it is locked, in words. Null when it is not. */
      readonly reason: string | null;
      /** Which slot the next keypress lands in, or null. Drawn as `[?]`. */
      readonly armedSlot: number | null;
    }
  | {
      readonly kind: typeof MenuRowKind.Status;
      readonly text: string;
      readonly tone: MenuTone;
    }
  | {
      readonly kind: typeof MenuRowKind.Footer;
      /** Which page the player asked for. Clamped by the geometry, never here. */
      readonly page: number;
    }
  | {
      readonly kind: typeof MenuRowKind.Note;
      readonly text: string;
      /**
       * THIS NOTE LABELS THE ROWS UNDER IT, so the orphan rule must carry it.
       *
       * A lore category is deliberately a `Note` and not a `Section` — see
       * `journalRows`, which argues it — and the orphan rule in `place` only ever
       * asked about `Section`. So a category could be the LAST row on the panel
       * with nothing beneath it and `N more — panel too small` directly under,
       * which is `ALDERBROOK` labelling the message that says its contents were
       * dropped. Seen on a rendered sheet at two viewports.
       *
       * `place`'s existing rule, unchanged in substance: a heading carries the
       * first row after it or it goes with them.
       */
      readonly heading?: boolean;
      /**
       * A PLACEHOLDER FOR AN EMPTY SECTION, WHICH IS THE FIRST THING TO GO.
       *
       * See `escapeMenuGeometry`'s `dropEmptySections`. It is the only kind of
       * row on this surface that carries no information a player came for, so
       * when the panel cannot hold everything it is dropped in preference to a
       * row that does.
       */
      readonly placeholder?: boolean;
    };

/** A capture waiting for exactly one keypress. See `applyCapture`. */
export type ArmedCapture = {
  readonly actionId: string;
  /** 0 or 1. The wire carries two slots and so does this. */
  readonly slot: number;
};

/**
 * Everything the surface is built from.
 *
 * `keymap` IS THE COMPILED OBJECT AND NOT A REMAP, because the overlay travels
 * ON it (`Keymap.remap`) — so a renderer needs ONE value rather than two that
 * can disagree, and `labelFor` can show the frozen floor as well as the slots.
 *
 * `persisted` IS THE SERVER'S OWN ANSWER, off the last `keybinds` frame. It is
 * false for an anonymous socket, and saying so on this screen is the difference
 * between a working feature and one the first plain-browser session reports as
 * broken.
 */
export type EscapeMenuView = {
  readonly screen: MenuScreen;
  readonly keymap: Keymap;
  readonly persisted: boolean;
  /** False for a party of one: LEAVE PARTY is drawn greyed rather than dropped. */
  readonly inParty: boolean;
  /**
   * Whether there is a character list to go back to — true for a signed-in
   * player and false for an anonymous one, who has no account and therefore no
   * roster.
   *
   * GREYED RATHER THAN DROPPED, like `inParty` above and for the same stated
   * reason: the row count is fixed so a menu never moves the row somebody was
   * already reaching for. For an anonymous player "switch character" would not
   * switch anything — it would drop them into the same world as a different
   * anonymous body, which is losing a character rather than changing one.
   *
   * OPTIONAL and defaulting to absent, so a caller that predates the select
   * screen compiles unchanged and gets the greyed row.
   */
  readonly canSwitchCharacter?: boolean;
  /** Which page of the Keys screen. Clamped by the geometry; any integer is safe. */
  readonly page: number;
  readonly armed: ArmedCapture | null;
  /** The last thing `applyCapture` said, or null. Shown on the status line. */
  readonly message: string | null;
  /**
   * TALENT POINTS IN HAND, for row 3's label: `TALENTS (2)`. `ProgressMsg.unspent`.
   *
   * ═══ A LONGER LABEL ON THE SAME ROW, NEVER A ROW OF ITS OWN ═══
   * `rootRows` is a FIXED count in one order, and that constraint is stated in
   * full there. The count goes INSIDE the label of the row that already opens
   * the talent panel, so nothing moves and nothing is added: this is one of the
   * two working affordances (the other is ui/charsheet.ts's `[G]` control) that
   * routed to the spend screen without ever saying how many points were behind
   * them.
   *
   * (The list is SEVEN rows now, not six. `SWITCH CHARACTER` earned one because
   * it is a VERB with nowhere else to live — there is no other surface in this
   * client that ends a session — where a spend count is a fact about a row that
   * already exists. It is drawn greyed rather than dropped for a player with no
   * account, exactly as `LEAVE PARTY` is for a party of one, so the count is
   * still fixed and no row ever moves.)
   *
   * OPTIONAL, defaulting to 0, so main.ts's existing `escapeMenuView()` compiles
   * unchanged and degrades to the label this row has always had.
   */
  readonly unspent?: number;
  /**
   * EVERY NOTE THIS CHARACTER HAS READ, in `LORE` order — `LoreMsg.notes`.
   *
   * Optional, and absent means "no frame yet" rather than "none found": a
   * client that has not been told draws the launcher greyed with a reason,
   * which is this file's rule everywhere (see `LEAVE PARTY`).
   */
  readonly notes?: readonly LoreView[];
  /** Which one is unfolded, or null. At most one, so the panel never pages. */
  readonly openNote?: string | null;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT THIS CHARACTER HAS AGREED TO DO. The Journal's other half.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ═══ REAL, AND EMPTY UNTIL SOMETHING PRODUCES ONE ═══
   * No frame carries a quest today and no code in this client fills this field,
   * so the QUESTS section renders its empty state for every player. It is a
   * FIELD rather than a hard-coded `[]` because the section has to be provably
   * able to draw a quest before anything ships one — a section that could only
   * ever be empty is a heading, not a section, and the test for it would be
   * testing the fixture (memory `tests-true-of-the-fixture`).
   *
   * Optional and absent means "none", which is the same picture as `[]` here:
   * unlike `notes`, there is no launcher to grey and therefore no third state to
   * distinguish. When a producer lands it will want the notes rule instead
   * (absent = no frame yet), and this comment is the note to change it then.
   */
  readonly quests?: readonly JournalQuestView[];
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * WHICH ROOT ROW IS ONE PRESS FROM HAPPENING — or null.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ═══ TWO ROWS HERE END SOMETHING, AND NEITHER ASKED ═══
   * `SWITCH CHARACTER` takes the world away and `LEAVE PARTY` drops the party
   * the barrier scopes to — and both fired on a single click, from rows 6 and 7
   * of the menu every player opens most, adjacent to each other and one row from
   * `INVENTORY`. Upstream puts a yes/no popup in front of the equivalent
   * (`Game.lua:2561-2570`, `:2577-2587`: *"Save and go back to main menu?"*).
   *
   * ═══ AN ARM, NOT A POPUP, BECAUSE THIS CLIENT HAS NO POPUPS ═══
   * It has an ARM — the roster's `DEL` becomes `SURE?` (ui/roster.ts) and the
   * talent panel's `+` is two presses because "there is no refund". This is the
   * same gesture on the same kind of act, so it is one vocabulary rather than a
   * modal invented for two rows.
   *
   * IT DISARMS ON ANYTHING ELSE — see `menuConfirm` in main.ts. An arm that
   * survived a hover to another row would be a `SURE?` sitting under a pointer
   * that had moved on.
   */
  readonly confirming?: number | null;
  /**
   * THE CURRENT INTERFACE STEP, `UI_SCALE_MIN`..`UI_SCALE_MAX` — see `ui-scale`.
   *
   * ON THE VIEW rather than read from the renderer, because this module draws
   * and never touches a canvas: the row is a READOUT as well as a control, and
   * a label that lagged the setting by a frame would be a preference screen
   * lying about the preference.
   *
   * ABSENT READS AS 0, the shipped default — which is what a client with no
   * `settings` frame yet is actually looking at.
   *
   * IT DECIDES WHICH ARROW IS GREYED and nothing else: the two ends of
   * `UI_SCALE_MIN`..`UI_SCALE_MAX` are the ends of the control. What the step
   * LOOKS like is `uiScalePercent`, which is a different question.
   */
  readonly uiScale?: number;
  /**
   * WHAT THAT STEP ACTUALLY DREW, AS A PERCENTAGE OF THE DEFAULT ONE.
   *
   * ═══ IT IS MEASURED, NOT DERIVED FROM THE STEP ═══
   * `hudScale` is a WHOLE number clamped by what the window can hold, so the
   * step and the picture are not the same fact: on a window whose automatic
   * factor is 2, one step up is 3 — 150% — and on a window that has no room
   * for a second factor every step draws 100%. The caller reads it off the
   * renderer's own answer (`setUiScale`'s RETURN, which is the clamped step),
   * so this row prints what the player is looking at and never what was asked
   * for. That is the whole reason it is a percentage rather than a word: a word
   * that cycled while the screen did not move was the complaint.
   *
   * ABSENT READS AS 100, which is the default step drawing the default size.
   */
  readonly uiScalePercent?: number;
  /**
   * DOES THIS WINDOW HAVE ROOM FOR A SECOND INTERFACE FACTOR? Decides only
   * whether the UI SIZE row is greyed — `panelsMoved`'s twin, one rule up.
   *
   * TRUE ON ANY WINDOW UNDER 1280x640, where scale 1 is the only whole factor
   * that fits and every step therefore lands on it. The row would otherwise
   * cycle four words while the screen never changed, which reads as a broken
   * control rather than as a window that is too small — see `uiScaleFixed` in
   * render/canvas.ts, which is where the arithmetic lives.
   *
   * ABSENT READS AS FALSE, so a caller that has not been taught to measure gets
   * the live row rather than a permanently greyed one.
   */
  readonly uiScaleFixed?: boolean;
  /**
   * HAS ANY PANEL BEEN DRAGGED? Decides only whether RESET PANELS is greyed.
   *
   * GREYED, NOT DROPPED — the rule this menu follows everywhere: a row that
   * vanished when it had nothing to do would change the panel's height and move
   * the row somebody was reaching for.
   */
  readonly panelsMoved?: boolean;
};

/**
 * WHY AN ACTION CANNOT BE REBOUND, in words, on the row.
 *
 * TWO LOCKED KINDS AND NO THIRD: `cancel` and the four hotbar digits are exactly
 * the actions `keymap.ts` marks `rebindable: false`, and a test in
 * test/client/input/keymap.test.ts pins that list by name. The reason lives here
 * rather than on the record because it is a SENTENCE FOR A SCREEN, and
 * keymap.ts is read by the dispatcher, which has no screen.
 */
function lockReason(action: ActionDef): string | null {
  // SAID ONCE UNDER THE HEADING instead, by `sharedLockReason` — see the note
  // in `keysRows`. Null here is what keeps the row at `ROW_H`.
  if (sharedLockReason(action.group) !== null) return null;
  // keys.ts calls Escape "the one key in the game that means put that back"; it
  // is also this menu's opener, so freezing it is what makes RESET ALL reachable
  // no matter what the player has done to the rest of the keyboard.
  return 'Escape must always reach this menu';
}

/**
 * A reason that belongs to a whole GROUP, drawn once under its heading.
 *
 * ONE GROUP HAS ONE, and the shape is deliberately a lookup rather than a
 * boolean: the next group that locks all of its members for a single reason
 * gets a line here and needs no other change.
 *
 * ui/hotbar.ts paints `${index + 1}` as the label of every TALENT slot — the
 * four item slots carry no digit precisely because no key sends them — so a
 * rebound digit makes an on-screen button lie, and the manifest has no keycap
 * glyphs to redraw one with.
 */
function sharedLockReason(group: KeyGroup): string | null {
  return group === 'Hotbar' ? 'these digits are painted on the slots' : null;
}

/** One root entry, with its live key. */
function entryRow(
  index: number,
  effect: MenuEffect,
  label: string,
  keyLabel: string,
  enabled: boolean,
  reason: string | null,
): Extract<MenuRow, { kind: typeof MenuRowKind.Entry }> {
  return { kind: MenuRowKind.Entry, index, effect, label, keyLabel, enabled, reason };
}

/**
 * THE ROOT SCREEN. TEN ROWS, ALWAYS TEN, IN THIS ORDER.
 *
 * The count is fixed on purpose (ui/contextmenu.ts:94-102): a menu whose shape
 * changes with state moves the row the player was already reaching for. Both
 * conditional rows — LEAVE PARTY for a party of one, SWITCH CHARACTER for a
 * player with no account — are drawn GREYED WITH A REASON rather than dropped,
 * which is how the count stays fixed while the menu still tells the truth.
 *
 * It was six until v19. `SWITCH CHARACTER` earned a row because it is a VERB
 * with nowhere else to live: no other surface in this client ends a session.
 * The unspent-points count was refused a row of its own under the same rule and
 * went inside the TALENTS label instead, which is the distinction — a fact
 * about an existing row goes on that row, a new verb gets a row.
 *
 * IT WAS ELEVEN UNTIL THE ZOOM ROW WENT (*"remove the (zoom) option"*), and the
 * three `ROW_*` constants above moved with it rather than the numbers being
 * chased through main.ts and the tests by hand.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TWO ROWS THAT END SOMETHING, BY INDEX.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `LEAVE PARTY` drops the party the barrier scopes to; `SWITCH CHARACTER` takes
 * the world away. Both take a confirming second press — see
 * `EscapeMenuView.confirming` — and the gate that enforces it lives in main.ts,
 * so the numbers have to be stated somewhere BOTH can read them.
 *
 * HERE, BESIDE `rootRows`, WHICH IS WHAT ASSIGNS THEM. A copy in main.ts would
 * be two opinions about which row is which, and the day somebody inserts a row
 * the confirmation would silently move to `INVENTORY` — a guard protecting the
 * wrong thing is worse than no guard, because it reads as protection.
 */
// ALL THREE MOVED DOWN ONE when the UI SIZE row joined the settings group, and
// back UP one when the ZOOM row left it. They are constants and not literals
// precisely so that this is a one-line change and not a hunt through main.ts and
// the tests -- which is exactly what it was both times.
// RENAMED WITH THE ROW, NOT LEFT BEHIND. It was `ROW_CASE_NOTES`, and a
// constant still named after a screen that no longer exists is how a reader
// ends up grepping for a thing this build does not have — `check-the-symbol-
// exists`, from the other direction. The NUMBER did not move: the row is still
// the eighth, because the rename added no row.
export const ROW_JOURNAL = 7;
export const ROW_LEAVE_PARTY = 8;
export const ROW_SWITCH_CHARACTER = 9;

/**
 * How the interface size reads on its row: a PERCENTAGE, not a word.
 *
 * ═══ IT WAS FOUR WORDS AND THE WORDS COULD LIE ═══
 * SMALLER / NORMAL / LARGER / LARGEST named the STEP, and the step is not the
 * picture: `hudScale` is a whole number clamped by what the window can hold, so
 * on most windows two of those words drew the same interface and the row
 * appeared to do nothing twice. A percentage cannot lie in that direction — it
 * is measured off what the renderer settled on, so a step that changed nothing
 * prints the same number, which is the truth rather than a fifth word for it.
 *
 * ROUNDED TO A WHOLE PERCENT. The factor is a ratio of two small integers, so
 * the only values this can produce are things like 50, 100, 150, 200 and 33 —
 * a decimal place would be noise on a readout a player glances at.
 */
function uiScalePercentText(percent: number): string {
  return `${String(Math.max(1, Math.round(percent)))}%`;
}

function rootRows(view: EscapeMenuView): readonly MenuRow[] {
  const keymap = view.keymap;
  // THE COUNT, ON THE LABEL, ONLY WHILE THERE IS ONE. A row reading
  // "TALENTS (0)" on every open is furniture within one session, which is the
  // same conditional ToME applies to its levelup EMPHASIS
  // (uiset/Minimalist.lua:1512-1516, LevelupDialog.lua:690-691). What is NOT
  // conditional is the spend screen's own count — see ui/talents.ts's
  // `pointsText`, which states one of three things at every level. This is a
  // launcher, not the screen.
  const unspent = Math.max(0, Math.floor(view.unspent ?? 0));
  const talentsLabel = unspent > 0 ? `TALENTS (${String(unspent)})` : 'TALENTS';

  /**
   * ═══ A ROW THAT IS ONE PRESS FROM HAPPENING SAYS SO, IN ITS OWN LABEL ═══
   * The roster's DEL does exactly this (`ui/roster.ts`), and putting the state
   * ON the control is what makes the second press deliberate: the player is no
   * longer pressing "SWITCH CHARACTER", they are pressing "SURE?".
   *
   * THE LABEL KEEPS ITS NAME BESIDE THE WORD. `SURE? SWITCH CHARACTER` rather
   * than a bare `SURE?`, because the arm can outlive a glance away and a row
   * that had lost its name would be a question about nothing.
   */
  const arm = (index: number, label: string): string =>
    view.confirming === index ? `SURE? ${label}` : label;
  return [
    // 'Esc', read off the keymap like every other row here — even though the key
    // is frozen, because the row must not become the one place a hard-coded
    // letter survives.
    entryRow(0, { kind: 'resume' }, 'RESUME', labelFor('cancel', keymap), true, null),
    entryRow(1, { kind: 'keys' }, 'KEY BINDINGS', '', true, null),
    /**
     * ═══ BESIDE THE OTHER PREFERENCE ROW, WHICH IS WHERE A PLAYER LOOKS ═══
     * The five rows below it open a panel; these change how the game is set up.
     * Grouping them is the whole reason upstream has a settings screen at all —
     * and three rows is not a screen, so they sit together here instead.
     *
     * NO KEY SHOWN, because it has none. Inventing a binding to fill the column
     * would put a key on the Keys screen that nobody asked for. It had a
     * NEIGHBOUR that did print one — the ZOOM row, which was a second route to
     * `zoom_in` — and that row is gone.
     *
     * ═══ ARROWS AND A PERCENTAGE, NOT A WORD THAT CYCLES ═══
     * *"the \"UI Size\" button should be arrows that change the scaling
     * percentage, not just smaller, larger, etc."* The row's own effect still
     * cycles (`delta: 0`) because that is the keyboard's one act per row; the
     * two arrows are `delta: -1` and `delta: +1` and clamp.
     *
     * GREYED WHERE THE WINDOW HAS NO ROOM, with the reason on the row — the
     * treatment `RESET PANELS` gets one rule down, and for the same argument:
     * a control that does nothing when pressed reads as broken. `place` then
     * builds no arrow boxes at all, so the greyed row has nothing in it to
     * press.
     *
     * STILL SHOWN, and still showing the setting. The preference is stored
     * server-side and follows the player to whatever they open the game on
     * next, so a small window must say what is set — it just must not claim it
     * can change it here.
     */
    {
      ...entryRow(
        2,
        { kind: 'ui-scale', delta: 0 },
        'UI SIZE',
        '',
        view.uiScaleFixed !== true,
        view.uiScaleFixed === true ? 'this window fits one size' : null,
      ),
      steppers: {
        // THE ENDS OF THE RANGE, AND NOTHING ELSE DECIDES THEM. `UI_SCALE_MIN`
        // and `UI_SCALE_MAX` are the control; `uiScalePercent` is the picture,
        // and the two are separate facts on purpose -- a step that draws the
        // same factor as its neighbour still MOVED, and the readout says so by
        // not changing rather than by an arrow lying about the bound.
        less: (view.uiScale ?? 0) > UI_SCALE_MIN,
        more: (view.uiScale ?? 0) < UI_SCALE_MAX,
        value: uiScalePercentText(view.uiScalePercent ?? 100),
      },
    },
    /**
     * THE THIRD AND LAST OF THE SETTINGS ROWS. Key bindings, interface size and
     * putting the panels back are the three that change how the game is SET UP;
     * the six below them open something or end something.
     */
    entryRow(
      3,
      { kind: 'reset-panels' },
      'RESET PANELS',
      '',
      view.panelsMoved === true,
      view.panelsMoved === true ? null : 'nothing has been moved',
    ),
    entryRow(
      4,
      { kind: 'ui', command: UiCommand.ShowSheet },
      'CHARACTER SHEET',
      labelFor('show_sheet', keymap),
      true,
      null,
    ),
    entryRow(
      5,
      { kind: 'ui', command: UiCommand.ShowTalents },
      talentsLabel,
      labelFor('show_talents', keymap),
      true,
      null,
    ),
    entryRow(
      6,
      { kind: 'ui', command: UiCommand.ShowInventory },
      'INVENTORY',
      labelFor('show_inventory', keymap),
      true,
      null,
    ),
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE JOURNAL. It was `CASE NOTES`, and it is no longer greyed when empty.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * ═══ THE COUNT SUFFIX SURVIVED THE RENAME, AND IT COUNTS NOTES ═══
     * `JOURNAL (3)` on the same rule every counted row here follows (see
     * `talentsLabel`): the number only while there is one. It is the NOTES
     * count and not a total, because the quests half has no producer yet — a
     * total would be the notes count wearing a name that promises more.
     * WHOEVER SHIPS BRIEFS OWNS THIS LINE: `journalCount` is the one place that
     * decides, so adding quests to it is one edit and not a hunt.
     *
     * ═══ IT USED TO BE GREYED WITH `nothing found yet`, AND THE KEY IS WHY
     *     THAT HAD TO STOP ═══
     * The old argument was sound for an ARCHIVE: a row that vanished would teach
     * nothing, so it stayed and said why it was dead. But this screen now has a
     * KEY on it (`show_journal`, `j`), and a key cannot be greyed. A player who
     * pressed `j`, read the Journal, closed it and then found the menu row for
     * the same screen greyed out would have two controls for one panel
     * disagreeing about whether the panel exists — which is the exact failure
     * `membership-is-not-a-rank` names, one level up from a list.
     *
     * AND THE SCREEN IS NOW WORTH OPENING EMPTY, which the archive was not. It
     * answers *"what am I doing?"*, and that question has an answer from the
     * first minute of the first evening even when the answer is "nothing yet".
     * Both sections say so in their own words — see `journalRows`.
     */
    entryRow(
      ROW_JOURNAL,
      { kind: 'journal' },
      `JOURNAL${journalCount(view) > 0 ? ` (${String(journalCount(view))})` : ''}`,
      labelFor('show_journal', keymap),
      true,
      null,
    ),
    // GREYED, NOT DROPPED. Everybody is always in a party — a solo player is a
    // party of one — so leaving alone is a no-op the server would refuse, which
    // is the same fact input/commands.ts answers locally for `/leave`.
    entryRow(
      ROW_LEAVE_PARTY,
      { kind: 'party', action: PartyAction.Leave },
      arm(ROW_LEAVE_PARTY, 'LEAVE PARTY'),
      '',
      view.inParty,
      view.inParty ? null : 'you are a party of one',
    ),
    /**
     * ═══ LAST, BECAUSE IT IS THE ONLY ROW THAT ENDS THE SESSION ═══
     * The five above are things you do WHILE playing; this one stops playing.
     * Bottom of the list is where every game in the genre puts that row, and the
     * distance from RESUME is the point — this is the row a player must travel
     * to deliberately.
     *
     * NO KEY, AND IT CANNOT BE GIVEN ONE. See `MenuEffect`'s note: a stray press
     * that dropped somebody out of a fight and back to a menu is not a mistake
     * worth making available.
     *
     * ONLY WHEN THERE IS A LIST TO GO BACK TO. An anonymous player has no
     * account and therefore no roster — leaving would drop them into the same
     * world as a different anonymous body, which is not "switching character",
     * it is losing one.
     */
    entryRow(
      ROW_SWITCH_CHARACTER,
      { kind: 'leave-character' },
      arm(ROW_SWITCH_CHARACTER, 'SWITCH CHARACTER'),
      '',
      view.canSwitchCharacter === true,
      view.canSwitchCharacter === true ? null : 'you are not signed in',
    ),
  ];
}

/**
 * One action's row: the name, both columns, the floor, and the lock.
 *
 * ═══ A LOCKED ROW SHOWS ITS FIXED KEYS IN THE COLUMNS, NOT '--' ═══
 * `cancel` and the four hotbar digits have EMPTY `defaults` and a `fixed` floor
 * — that is exactly what makes them unreachable by any remap — so reading their
 * two slots off the overlay would draw `-- --` and tell the player that Escape
 * and the digits are unbound, which is the opposite of true. The columns show
 * what the action actually answers to, which for a locked row is the floor.
 */
function actionRow(action: ActionDef, view: EscapeMenuView): MenuRow {
  const armed = view.armed;
  const floor = action.fixed.map(labelForBinding);
  const locked = !action.rebindable;
  return {
    kind: MenuRowKind.Action,
    actionId: action.id,
    name: action.name,
    slots: locked
      ? [floor[0] ?? '--', floor[1] ?? '--']
      : [labelFor(action.id, view.keymap, 0), labelFor(action.id, view.keymap, 1)],
    // NOT REPEATED ON A LOCKED ROW: its floor is already in the columns, and the
    // second line is spent on the reason instead.
    fixed: locked ? '' : floor.join(' / '),
    locked,
    reason: locked ? lockReason(action) : null,
    armedSlot: armed !== null && armed.actionId === action.id ? armed.slot : null,
  };
}

/**
 * THE ONE LINE THAT SAYS WHAT JUST HAPPENED, and the order of its four cases is
 * the design.
 *
 * ARMED FIRST, because a player waiting to press a key needs to know both ways
 * out before they press anything (KeyBinder.lua:82). Then the last ANSWER — a
 * conflict refusal names the holder and would be worthless a frame later. Then
 * the persistence warning, which is standing rather than urgent. Then the
 * instruction, which is the only one of the four that is ever furniture — and it
 * goes away the moment anything else has something to say.
 *
 * THE STRIP IS RESERVED WHETHER OR NOT IT HAS SOMETHING LOUD TO SAY, so nothing
 * on the screen moves when a capture arms. Rows shifting under a pointer that is
 * mid-gesture is ui/inventory.ts:145-151's trap, one screen over.
 */
function statusRow(view: EscapeMenuView): MenuRow {
  const armed = view.armed;
  if (armed !== null) {
    // THE SLOT, NOT THE ACTION. The line has about fifty-five characters at the
    // panel's width and the prompt itself is forty-five of them; the row already
    // says WHICH action, because the column the next press lands in is wearing
    // `[?]`. Spending the remaining ten on a name would have cost the half of
    // the sentence that names the two ways out.
    return {
      kind: MenuRowKind.Status,
      text: `key ${String(armed.slot + 1)}: ${ARMED_PROMPT}`,
      tone: MenuTone.Armed,
    };
  }
  if (view.message !== null && view.message !== '') {
    return { kind: MenuRowKind.Status, text: view.message, tone: MenuTone.Warn };
  }
  if (!view.persisted) {
    return { kind: MenuRowKind.Status, text: NOT_SAVED, tone: MenuTone.Warn };
  }
  return { kind: MenuRowKind.Status, text: KEYS_HINT, tone: MenuTone.Quiet };
}

/**
 * THE KEYS SCREEN, GROUPED AND STABLY SORTED.
 *
 * `KEY_GROUPS` is the outer order and `order` is the inner one, which is
 * KeyBinder.lua:196-202's own sort (`a.group ~= b.group` then `a.order`) with
 * one deliberate difference: upstream sorts its GROUPS alphabetically at :236,
 * which is why its screen opens on "Actions" rather than on movement. Ours is an
 * explicit list, so the sections read in the order a player learns them.
 *
 * A STABLE SORT ON A COPY. `ACTIONS` is never mutated — `resetOne` and
 * `resetAll` are one line each precisely because nothing in this feature writes
 * through to the defaults, which is the trap KeyBinder.lua:96-103 falls into by
 * storing `t.k.default` BY REFERENCE and then writing through it.
 */
function keysRows(view: EscapeMenuView): readonly MenuRow[] {
  const rows: MenuRow[] = [];
  for (const group of KEY_GROUPS) {
    const members = ACTIONS.filter((action) => action.group === group);
    if (members.length === 0) continue;
    rows.push({ kind: MenuRowKind.Section, label: group });
    /**
     * ═══ THE HOTBAR'S LOCK REASON IS THE GROUP'S, NOT NINE ROWS' ═══
     * Every action in this group is locked for the identical reason, so the
     * sentence went on all nine rows and cost each of them the ten extra pixels
     * of `LOCKED_ROW_H`. Ninety pixels to say one thing nine times.
     *
     * It was affordable at four rows and it stopped being affordable at nine:
     * the table outgrew the band at 1280x720 and the keys screen began paging —
     * `1-30 of 34` — which breaks the property the whole fill-sizing exists for.
     * Raising the caps could not fix it; even a fill of 1.0 was sixteen pixels
     * short, because the band is the space between the HUD and the hotbar and
     * not the window.
     *
     * So it is said ONCE, here, where a reader meets the group. `MenuRowKind.Note`
     * already existed for exactly this — a sentence about the screen rather than
     * about a row.
     */
    const shared = sharedLockReason(group);
    if (shared !== null) rows.push({ kind: MenuRowKind.Note, text: shared });
    for (const action of [...members].sort((a, b) => a.order - b.order)) {
      rows.push(actionRow(action, view));
    }
  }
  rows.push(statusRow(view));
  rows.push({ kind: MenuRowKind.Footer, page: view.page });
  return rows;
}

/**
 * THE SURFACE, AS AN ORDERED LIST OF LINES. Pure, and the whole port lives here.
 *
 * ONE function for all three screens, because there is one surface. The geometry
 * below pulls the Status and Footer rows out of the list rather than being told
 * which screen it is looking at, which is what lets it take no context at all.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE EMPTY STATES, AND THE RULE THEY ARE WRITTEN UNDER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * AN EMPTY SECTION SAYS WHAT BELONGS IN IT, IN THE PRESENT TENSE, AND PROMISES
 * NOTHING. `QUESTS` has no producer in this build — nothing in this client can
 * put a row in it — so the temptation is a line like "coming soon" or "once
 * briefs ship". Both are dated the moment they are written and neither is a
 * thing a player can act on; memory `deferral-notes-rot` is what happens to that
 * sentence six weeks later, on a screen, where a player reads it.
 *
 * So it describes the SECTION, which is true today: this is where what you agree
 * to is listed. It names no feature, no version and no date. When the first
 * brief lands, nothing here has to change for it to have been honest.
 *
 * ONE ROW, NOT TWO, AND THE REASON IS PIXELS RATHER THAN PROSE. It was two
 * lines; this surface has no scroll and a twelve-pixel row is a note body line
 * somebody loses at the floor viewport — see `escapeMenuRect`'s `tall`, which
 * carries the measurement. The dash is doing the work the second line did.
 */
const QUESTS_EMPTY = 'Nothing on hand — work you take on is listed here.';
/** Unchanged from the Case Notes screen, and still exactly right. */
const NOTES_EMPTY = 'Nothing written down yet.';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE JOURNAL, AS ROWS: `ShowQuests`'s list over `ShowLore`'s archive.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ THE NOTES HALF IS THE PORT IT ALWAYS WAS ═══
 * Upstream lists the party's known lore and opens the one you pick in its own
 * dialog. Ours unfolds it IN PLACE, under the row, because this surface is one
 * rect with one hit test and a second dialog would be the thing `MenuScreen`
 * exists to avoid.
 *
 * IN `LORE` ORDER, which the server already applied — `projectLore` iterates the
 * table and filters, so the archive reads the same way for everybody rather than
 * in whatever order a particular party happened to find things.
 *
 * THE CATEGORY IS STILL A `Note` ROW AND NOT A `Section`, and now it has to be:
 * the two SECTION headings are the structure of this screen, and a lore category
 * promoted to the same weight would make `THE INDEX` read as a third peer of
 * `QUESTS` and `NOTES` rather than as a shelf inside one of them.
 *
 * ═══ THE QUESTS HALF IS `ShowQuests.lua`'S TWO COLUMNS ON ONE LINE ═══
 * `:38-41` is a two-column list — "Quest" and "Status" — and `:89` fills them
 * from `q.name` and `q.status_text[q.status]`. Ours writes both on one `Note`
 * row, because the panel is one narrow column.
 *
 * NOT AN `Entry` ROW, DELIBERATELY. An `Entry` is a CONTROL: it lights under the
 * pointer, it answers a click and it carries a `MenuEffect`. A quest row has
 * nothing to do when pressed in this build — upstream's press opens the
 * description pane this surface has no room for — and a control that answers
 * nothing is this file's own worst failure mode, stated in `runMenuEffect`'s
 * neighbourhood and in `GameMenu.lua:125-133`'s dead "highscores" row. Text is
 * the honest kind for a row that is information.
 *
 * IN THE ORDER GIVEN, which is the producer's business exactly as `LORE` order
 * is. Upstream sorts by `q.gained_turn` when the game has a clock and by name
 * when it does not (`:92-96`); whatever lands here will have made that choice
 * before this function sees it, and a second sort in the painter would be two
 * opinions about one order.
 */
function journalRows(view: EscapeMenuView): readonly MenuRow[] {
  const rows: MenuRow[] = [];

  rows.push({ kind: MenuRowKind.Section, label: JournalSection.Quests });
  const quests = view.quests ?? [];
  for (const quest of quests) {
    /**
     * THE STATUS IS TRIMMED FIRST AND THE NAME SECOND, which is the opposite of
     * what one string did.
     *
     * `${name} — ${status}` is fitted to the column by `fitText`, which cuts
     * from the RIGHT — so a long quest name took the status with it and the row
     * became a name with no state at all. Upstream keeps them in two columns
     * that cannot eat each other (`ShowQuests.lua:38-41`), and the status is the
     * only thing this row exists to say: "Ashes of Alderbrook" is a name a
     * player already knows, "done" is the answer they opened the Journal for.
     *
     * So the NAME is clipped here, in characters, leaving the status whole. The
     * budget is the wrap width this panel already sizes itself by
     * (`NOTE_WRAP_CHARS`), minus the separator and the longest status word
     * upstream has (`Quest.lua:31-36`: "completed").
     */
    const room = NOTE_WRAP_CHARS - quest.status.length - 3;
    const name =
      quest.name.length > room ? `${quest.name.slice(0, Math.max(1, room - 1))}…` : quest.name;
    rows.push({ kind: MenuRowKind.Note, text: `${name} — ${quest.status}` });
  }
  if (quests.length === 0) {
    rows.push({ kind: MenuRowKind.Note, text: QUESTS_EMPTY, placeholder: true });
  }

  rows.push({ kind: MenuRowKind.Section, label: JournalSection.Notes });
  const notes = view.notes ?? [];
  let heading: string | null = null;
  let index = 0;
  for (const note of notes) {
    if (note.category !== heading) {
      heading = note.category;
      rows.push({ kind: MenuRowKind.Note, text: note.category.toUpperCase(), heading: true });
    }
    const open = view.openNote === note.id;
    rows.push(
      entryRow(
        index,
        { kind: 'note', id: note.id },
        `${open ? '- ' : '+ '}${note.name}`,
        '',
        true,
        null,
      ),
    );
    index += 1;
    // THE BODY, ONLY WHILE IT IS THE OPEN ONE. Every note unfolded at once would
    // be a panel taller than the window on the fifth find, and this surface has
    // no scroll — see the header's row budget.
    if (open)
      for (const line of wrapNote(note.text)) rows.push({ kind: MenuRowKind.Note, text: line });
  }
  if (notes.length === 0) {
    rows.push({ kind: MenuRowKind.Note, text: NOTES_EMPTY, placeholder: true });
  }
  return rows;
}

/**
 * WHAT THE LAUNCHER'S SUFFIX COUNTS. The ONE place that decides.
 *
 * NOTES ONLY, and that is a statement about this build rather than about the
 * word "journal": a quest cannot exist yet, so a total and this number are the
 * same number, and the one that will still be right the day they differ is the
 * one whose name says what it counted. Whoever ships briefs adds the term HERE
 * and the row, the tests and any future reader all move together.
 */
function journalCount(view: EscapeMenuView): number {
  return (view.notes ?? []).length;
}

/**
 * A greedy wrap on whole words, in CHARACTERS.
 *
 * This panel sizes itself from row COUNTS and never measures — see
 * `escapeMenuRect` — so a wrap that measured would be the one thing whose height
 * the rect could not predict, and the box would be the wrong size for its own
 * contents.
 */
const NOTE_WRAP_CHARS = 58;
function wrapNote(text: string): readonly string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    const next = line === '' ? word : `${line} ${word}`;
    if (next.length <= NOTE_WRAP_CHARS) {
      line = next;
      continue;
    }
    if (line !== '') out.push(line);
    line = word;
  }
  if (line !== '') out.push(line);
  return out;
}

export function escapeMenuRows(view: EscapeMenuView): readonly MenuRow[] {
  if (view.screen === MenuScreen.Keys) return keysRows(view);
  if (view.screen === MenuScreen.Journal) return journalRows(view);
  return rootRows(view);
}

// ---------------------------------------------------------------------------
// THE CAPTURE — a pure state machine, exactly one press wide
// ---------------------------------------------------------------------------

/**
 * ONE PRESS, AS THE FIELDS keys.ts READS.
 *
 * A plain record rather than a `KeyboardEvent`, which is what keeps this
 * function testable in node with no DOM at all — and a real event is
 * structurally assignable to it, so the caller passes the event straight in.
 *
 * `shiftKey` IS DELIBERATELY ABSENT AND ITS ABSENCE IS THE DESIGN. Every
 * key-side lookup in keys.ts lowercases and does NOT exclude Shift, so Shift+H
 * and H are the same press to the dispatcher (pinned at
 * test/client/input/keys.test.ts:314-316). A capture that reported "Shift+H"
 * would be promising a distinction the dispatcher cannot honour.
 */
export type CaptureInput = {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
};

export const CaptureKind = {
  /** A bare modifier. Nothing happens and THE CAPTURE STAYS ARMED. */
  Ignored: 'ignored',
  /** Escape. Binds nothing and disarms. The reason this is not self-bricking. */
  Disarmed: 'disarmed',
  /** Backspace. The slot is deliberately empty now. */
  Cleared: 'cleared',
  Bound: 'bound',
  /** Somebody else already answers that press. The row is UNCHANGED. */
  Conflict: 'conflict',
  /** A chord, a locked action, or a key the dispatcher could never deliver. */
  Refused: 'refused',
} as const;
export type CaptureKind = (typeof CaptureKind)[keyof typeof CaptureKind];

/**
 * EVERY OUTCOME BUT `Ignored` DISARMS. That is the one-press bound the header
 * promises, and it is what makes the barrier question not arise: there is no
 * state in which this screen is holding the keyboard and waiting for a human.
 */
export type CaptureOutcome =
  | { readonly kind: typeof CaptureKind.Ignored }
  | { readonly kind: typeof CaptureKind.Disarmed }
  | {
      readonly kind: typeof CaptureKind.Cleared;
      /** A NEW remap. The caller sends it and compiles it; nothing here mutates. */
      readonly remap: KeyRemap;
      readonly message: string;
    }
  | {
      readonly kind: typeof CaptureKind.Bound;
      readonly remap: KeyRemap;
      readonly message: string;
    }
  | {
      readonly kind: typeof CaptureKind.Conflict;
      readonly holder: string;
      readonly holderName: string;
      readonly message: string;
    }
  | { readonly kind: typeof CaptureKind.Refused; readonly message: string };

/**
 * The `event.key` values that are a modifier and nothing else.
 *
 * KeyBinder.lua:88-93 skips exactly these — its eight `_LCTRL/_RCTRL/_LSHIFT/…`
 * syms — and RETURNS WITHOUT CLOSING THE DIALOG, so the capture is still waiting
 * when the player finishes reaching for the key they actually meant.
 */
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  'shift',
  'control',
  'alt',
  'meta',
  'altgraph',
  'capslock',
  'numlock',
  'scrolllock',
  'os',
  'contextmenu',
]);

/** The two keys with a meaning of their own inside a capture. */
const CANCEL_KEY = 'escape';
const CLEAR_KEY = 'backspace';

/**
 * WHICH OF THE PRESS'S TWO IDENTITIES TO STORE.
 *
 * THE NUMPAD IS THE ONE PLACE `code` WINS AND IT IS NOT A PREFERENCE: with
 * NumLock on, Numpad8's `event.key` is the string '8' — indistinguishable from
 * the number row and therefore from the hotbar — and with it off it is
 * 'ArrowUp'. The physical key is the only stable identity, which is why
 * keymap.ts keeps two namespaces at all.
 *
 * Everything else is stored as a lowercased `key`, so the binding follows the
 * player's LAYOUT: on AZERTY the physical KeyH is not where an H is printed.
 */
function bindingFor(input: CaptureInput): Binding | undefined {
  if (input.code.startsWith('Numpad')) return { kind: 'code', value: input.code };
  const key = input.key.toLowerCase();
  // 'Unidentified' and 'Dead' are what a browser reports for a press it could
  // not name; storing either would bind a key nothing can ever match again.
  if (key === '' || key === 'unidentified' || key === 'dead') return undefined;
  return { kind: 'key', value: key };
}

/**
 * WHAT ONE KEYPRESS MEANS WHILE A CAPTURE IS ARMED.
 *
 * ═══ PORTED FROM KeyBinder.lua:82-106, RULE FOR RULE ═══
 *   bare modifier      IGNORED, and the capture stays armed          (:88-93)
 *   Backspace          CLEARS the slot                               (:95-97)
 *   Escape             binds NOTHING and disarms                     (:98)
 *   anything else      becomes a key string and is written           (:99-103)
 *
 * ═══ AND THREE REFUSALS UPSTREAM HAS NO ANALOGUE FOR ═══
 * A Ctrl/Alt/Meta CHORD is refused with a sentence, because keys.ts:340-342
 * discards those globally ("those are the browser's and Discord's shortcut
 * space") — so accepting one would bind a key the dispatcher can never deliver,
 * and the rebind would appear to take and then do nothing.
 *
 * A LOCKED ACTION is refused, including for Backspace: `cancel` and the four
 * hotbar digits are `rebindable: false` in keymap.ts and `setBinding` /
 * `clearBinding` would refuse them silently. Saying so is the difference between
 * a rule and a broken button.
 *
 * A CONFLICT is refused, THE HOLDER IS NAMED, AND THE ROW IS LEFT ALONE. Not a
 * swap — that is a second edit the player did not ask for, and it can leave them
 * holding two half-broken actions. Not a silent shadow — that is upstream's
 * behaviour, and it is a lottery: KeyBinder.lua does no lookup at all, so the
 * collision surfaces later in `bindKeys` and is resolved by `pairs` hash order
 * (KeyBind.lua:227-232), which can differ between runs of the same build.
 * `conflictsFor` arbitrates by walking the REAL dispatch order instead, so
 * "Numpad1 and the hotbar's 1 are the same physical press" falls out for free.
 *
 * PURE. It returns a NEW remap and never touches the live keymap; the caller
 * compiles it and sends it, so what the screen finally draws is what the SERVER
 * echoed back.
 */
export function applyCapture(
  armed: ArmedCapture | null,
  input: CaptureInput,
  keymap: Keymap,
): CaptureOutcome {
  if (armed === null) return { kind: CaptureKind.Ignored };

  const key = input.key.toLowerCase();
  if (MODIFIER_KEYS.has(key)) return { kind: CaptureKind.Ignored };
  if (key === CANCEL_KEY) return { kind: CaptureKind.Disarmed };

  const action = actionById(armed.actionId);
  if (action === undefined) {
    // The armed action left the build between the press that armed it and this
    // one. Unreachable today; answered rather than thrown, because a menu that
    // throws takes the whole frame down.
    return { kind: CaptureKind.Refused, message: 'that action is no longer in the game' };
  }
  if (!action.rebindable) {
    // A locked row draws no controls, so this is only reachable from an armed
    // state nothing on screen can produce. It is answered anyway: `setBinding`
    // would refuse it silently, and a silent refusal is how a rule becomes a
    // broken button. Kept SHORT — the status line holds about fifty-five
    // characters at the panel's width.
    return { kind: CaptureKind.Refused, message: `locked — ${lockReason(action)}` };
  }
  if (!Number.isInteger(armed.slot) || armed.slot < 0 || armed.slot >= SLOTS_PER_ACTION) {
    return { kind: CaptureKind.Refused, message: 'there are only two keys per action' };
  }

  const slotWord = `key ${String(armed.slot + 1)}`;

  if (key === CLEAR_KEY) {
    return {
      kind: CaptureKind.Cleared,
      remap: clearBinding(keymap.remap, action.id, armed.slot),
      message: `${action.name}: ${slotWord} is now empty`,
    };
  }

  if (input.ctrlKey || input.altKey || input.metaKey) {
    return { kind: CaptureKind.Refused, message: 'Ctrl, Alt and Meta never reach the game' };
  }

  const binding = bindingFor(input);
  if (binding === undefined) {
    return { kind: CaptureKind.Refused, message: 'the browser could not name that key' };
  }
  if (!canDeliver(action, binding)) {
    // A `code:` binding on anything but a direction or a turn command. keys.ts
    // has exactly two code-keyed tables and adding a third means editing the
    // eight-step dispatch order, which is load-bearing.
    return {
      kind: CaptureKind.Refused,
      message: `${labelForBinding(binding)} is a numpad key — movement and turn keys only`,
    };
  }

  const clash = conflictsFor({ action: action.id, binding }, keymap)[0];
  if (clash !== undefined) {
    return {
      kind: CaptureKind.Conflict,
      holder: clash.holder,
      holderName: clash.holderName,
      message: `${labelForBinding(binding)} is already ${clash.holderName} — clear that first`,
    };
  }

  return {
    kind: CaptureKind.Bound,
    remap: setBinding(keymap.remap, action.id, armed.slot, binding),
    message: `${action.name}: ${slotWord} is now ${labelForBinding(binding)}`,
  };
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
 * `height` is the logical viewport and clamps `bottom` IN TURN — a caller that
 * computed a band against a stale viewport size cannot push the panel off the
 * bottom of the screen, where its close button would be unreachable and the
 * player would be looking at a menu they cannot dismiss with the mouse.
 *
 * CENTRED HORIZONTALLY because both sides are taken (ui/partypanel.ts holds the
 * left, the Case Log holds the right) and CENTRED VERTICALLY, which is the
 * character sheet's anchor rather than a fourth one. There is no fourth anchor
 * left — the sheet centres, ui/talents.ts pins to the top, ui/inventory.ts pins
 * to the bottom — and this panel is wider than all three, so no anchor could
 * make it miss them anyway. The paint order in main.ts decides, and this surface
 * is the most recently opened one.
 */
export function escapeMenuRect(options: {
  /** Logical backbuffer width, in world pixels — not device pixels. */
  readonly width: number;
  /** Logical backbuffer height. Clamps `bottom`; see above. */
  readonly height: number;
  /** First free pixel under the top HUD. */
  readonly top: number;
  /** First pixel of the bottom bands (the hotbar and the prose lines). */
  readonly bottom: number;
  /**
   * Which screen is up. OPTIONAL and defaulting to the root's compact size, so
   * every existing caller keeps the rect it had. See the note on `KEYS_FILL_W`.
   */
  readonly screen?: MenuScreen;
  /**
   * WHAT IS ACTUALLY IN IT, from `escapeMenuRows`. OPTIONAL, and a caller that
   * omits it gets the size this function gave before the parameter existed.
   *
   * It is the character sheet's `pages` in miniature and for the same reason —
   * `charSheetRect` is handed every page so the panel is the size of its
   * contents rather than the size of its ceiling. Without it the Journal grew to
   * the top of its range whatever it held: an EMPTY journal was a 360x704 box
   * around ninety pixels of rows at 1920x1080, which reads as a broken panel
   * rather than as an empty one.
   */
  readonly rows?: readonly MenuRow[];
}): PanelRect | null {
  const { width, height, top } = options;
  const bottom = Math.min(options.bottom, height);
  const band = bottom - top;
  if (band < PANEL_MIN_H + PANEL_MARGIN * 2) return null;
  if (width < PANEL_MIN_W + PANEL_MARGIN * 2) return null;

  /**
   * THE SCREEN DECIDES THE SIZE, AND ONE RESOLVER ANSWERS FOR BOTH THE PAINTER
   * AND THE HIT TEST.
   *
   * `client/main.ts` has a single `rectFor(panel)` that the drawing pass and
   * every click go through, so the two cannot disagree about which rect is on
   * screen. Passing `screen` through it keeps that property; a second copy of
   * this arithmetic on the input side is how a panel ends up drawn in one place
   * and clickable in another.
   *
   * ABSENT MEANS ROOT, which is what every caller that does not care wants and
   * what this function did before the parameter existed.
   */
  const roomy = options.screen === MenuScreen.Keys;

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE JOURNAL GROWS DOWN AND NOT ACROSS, AND IT IS A MEASURED FIX.
   * ═══════════════════════════════════════════════════════════════════════════
   * The Journal gained two SECTION rows and an empty-quests line on top of the
   * archive it already drew, which is 48 pixels off a body that was 212 tall.
   * Measured against the five notes this build ships, in three categories, with
   * ONE unfolded: 166 pixels before, 214 after. It went over at EVERY viewport,
   * and the screen has no pager — it would have degraded to `3 more — panel too
   * small` on a 1280x720 monitor, which is a correct message about a wrong
   * layout.
   *
   * SO IT TAKES THE KEYS SCREEN'S HEIGHT RULE AND NOT ITS WIDTH RULE. Height,
   * because a list of things you have read grows downward for ever and this is
   * the same argument `KEYS_FILL_H` already makes. NOT width, because a note's
   * body is wrapped at a FIXED `NOTE_WRAP_CHARS` — this panel sizes itself from
   * row counts and never measures text — so a 560-pixel Journal would be a
   * 58-character column with 200 pixels of air beside it.
   *
   * AT 640x320, THE DECLARED FLOOR, IT STILL DOES NOT ALL FIT with a note open,
   * and nothing here can fix that: the band is 260 pixels and `h` is clamped
   * into it. That case degrades the way this surface already degrades — the
   * `N more — panel too small` line in `escapeMenuGeometry`, which is the
   * footerless screen's honest answer and is tested.
   */
  const tall = roomy || options.screen === MenuScreen.Journal;

  /**
   * NEVER SMALLER THAN THE COMPACT PANEL, WHICH THE FIRST VERSION OF THIS GOT
   * WRONG AND THE PROBE CAUGHT.
   *
   * A FRACTION of a short band is less than a fixed 252, so sizing the keys
   * screen purely by fill made the 640x320 floor go from `1–12 of 29` to
   * `1–9 of 29`. A change meant to reduce paging added a page on the one
   * viewport with the least room to spare — the same shape as the rule in this
   * client that a fix which makes a row taller can delete a row. So the fill is
   * a FLOOR-RAISING rule, not a replacement: it can only ever hand this screen
   * more than the root would have had. That is why the Journal can borrow the
   * height half of it with no case to check: at worst it is handed the 252 it
   * had.
   */
  const wantW = roomy
    ? Math.max(PANEL_W, Math.min(KEYS_MAX_W, Math.floor(width * KEYS_FILL_W)))
    : PANEL_W;
  /**
   * AS TALL AS ITS CONTENTS, AND NEVER TALLER — inside the range above.
   *
   * The two bounds are unchanged: `PANEL_MAX_H` is still the floor this screen
   * can never drop below and the fill is still the ceiling it can never pass.
   * What is new is that a panel with four rows in it asks for four rows.
   *
   * ═══ THE JOURNAL ONLY, AND THAT IS NOT TIMIDITY ═══
   * The Keys screen EARNS the fill: it is the one surface here with more rows
   * than fit, it has a pager drawn on a footer, and a player on that screen is
   * scanning a long list — every pixel it is given is a key they do not have to
   * page to. The Journal is the opposite: it is usually four rows, and at
   * 1920x1080 the fill made an EMPTY one a 360x704 box around about ninety
   * pixels of parchment, which reads as broken rather than as empty. Sizing the
   * Keys screen from its contents as well would shrink it at exactly the
   * viewports where everything already fits — no rows gained, a working screen
   * changed — so it is left alone, and a test pins that its rect does not move
   * when the rows are passed.
   *
   * ROWS THAT ARE NOT GIVEN MEAN "FILL", which is what every caller that does
   * not pass them had.
   */
  const ceilingH = Math.min(KEYS_MAX_H, Math.floor(band * KEYS_FILL_H));
  const fitted =
    options.screen === MenuScreen.Journal && options.rows !== undefined
      ? options.rows.reduce((sum, row) => sum + rowHeight(row), 0) + HEADER_H + INSET * 2
      : ceilingH;
  const wantH = tall ? Math.max(PANEL_MAX_H, Math.min(ceilingH, fitted)) : PANEL_MAX_H;

  // Clamped so a growing panel can never be wider than the space it is centred
  // in, nor narrower than the floor the two guards above just accepted.
  const w = Math.min(Math.max(PANEL_MIN_W, wantW), width - PANEL_MARGIN * 2);
  const h = Math.min(Math.max(PANEL_MIN_H, wantH), band - PANEL_MARGIN * 2);
  return {
    x: Math.floor((width - w) / 2),
    y: top + Math.max(0, Math.floor((band - h) / 2)),
    w,
    h,
  };
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
function rowHeight(row: MenuRow): number {
  switch (row.kind) {
    case MenuRowKind.Entry:
      return ENTRY_H;
    case MenuRowKind.Section:
      return SECTION_H;
    case MenuRowKind.Action:
      // THE SECOND LINE IS WHAT COSTS THE PIXELS, so the question is whether
      // this row carries a reason — not whether it is locked. A row locked for
      // a reason its GROUP already states has nothing to put on line two.
      return row.reason !== null ? LOCKED_ROW_H : ROW_H;
    case MenuRowKind.Status:
      return STATUS_H;
    case MenuRowKind.Footer:
      return FOOTER_H;
    case MenuRowKind.Note:
      return NOTE_ROW_H;
  }
}

/**
 * THE FOUR COLUMNS ON A KEY ROW, right to left: `[D]`, `[X]`, key 2, key 1.
 *
 * ONE copy, read by the geometry (which turns them into controls) AND by the
 * painter (which draws plain TEXT in them for a locked row, so the table still
 * lines up). ui/partypanel.ts:93-99 records what a second copy costs.
 */
function keyColumns(rowRect: PanelRect): {
  readonly slots: readonly [PanelRect, PanelRect];
  readonly clear: PanelRect;
  readonly reset: PanelRect;
  /** Everything left of the first key column: the name and its annotation. */
  readonly nameW: number;
} {
  const y = rowRect.y + Math.floor((ROW_H - BTN_H) / 2);
  const right = rowRect.x + rowRect.w;
  const reset: PanelRect = { x: right - CTRL_W, y, w: CTRL_W, h: BTN_H };
  const clear: PanelRect = { x: reset.x - CTRL_GAP - CTRL_W, y, w: CTRL_W, h: BTN_H };
  const slot2: PanelRect = { x: clear.x - CTRL_GAP - KEY_COL_W, y, w: KEY_COL_W, h: BTN_H };
  const slot1: PanelRect = { x: slot2.x - CTRL_GAP - KEY_COL_W, y, w: KEY_COL_W, h: BTN_H };
  return {
    slots: [slot1, slot2],
    clear,
    reset,
    nameW: Math.max(0, slot1.x - CTRL_GAP - rowRect.x),
  };
}

/**
 * WHERE THE UI SIZE ROW'S TWO ARROWS AND ITS READOUT SIT. ONE COPY OF IT.
 *
 * `keyColumns`' shape and for its reason: `place` fills the hit boxes from this
 * and `drawRow` draws from this, so there is exactly one opinion about where a
 * control is. ui/partypanel.ts:93-99 records what losing that property costs.
 *
 * RIGHT-ALIGNED, because the row's label is left-aligned and an Entry row's
 * right-hand side is where its second fact has always gone (the key, or the
 * reason it is greyed). `right` matches the 3px inset `drawRow` already uses
 * for that text.
 */
function stepperColumns(rowRect: PanelRect): {
  readonly less: PanelRect;
  readonly value: PanelRect;
  readonly more: PanelRect;
} {
  // The plate is `rect.h - 2` tall -- see `drawRow` -- so the buttons centre in
  // that and not in the row's full height, or they would sit a pixel low.
  const plateH = rowRect.h - 2;
  const y = rowRect.y + Math.floor((plateH - BTN_H) / 2);
  const right = rowRect.x + rowRect.w - 3;
  const more: PanelRect = { x: right - STEP_BTN_W, y, w: STEP_BTN_W, h: BTN_H };
  const value: PanelRect = {
    x: more.x - STEP_GAP - STEP_VALUE_W,
    y,
    w: STEP_VALUE_W,
    h: BTN_H,
  };
  const less: PanelRect = { x: value.x - STEP_GAP - STEP_BTN_W, y, w: STEP_BTN_W, h: BTN_H };
  return { less, value, more };
}

/** One row, placed, with whatever controls it carries. */
export type PlacedMenuRow = {
  readonly row: MenuRow;
  readonly rect: PanelRect;
  /**
   * The two key columns AS CONTROLS. Empty for every row but a REBINDABLE
   * action — a locked row's columns are drawn as text and answer no click, which
   * is what makes "unpressable" structural rather than a check somebody can
   * forget.
   */
  readonly slots: readonly PanelRect[];
  readonly clear: PanelRect | null;
  readonly reset: PanelRect | null;
  /**
   * THE TWO ARROWS ON THE UI SIZE ROW, AS CONTROLS. Null on every other row,
   * and null on that row when it is GREYED — `slots`' rule exactly: a control
   * drawn as unpressable must be unpressable, and making that structural is
   * what stops it being a check somebody forgets.
   *
   * An arrow at the end of the range is present here and still answers null in
   * the hit test, because the painter has to draw it greyed: a row that lost an
   * arrow at the bottom of the range would change width under the pointer.
   */
  readonly steppers: { readonly less: PanelRect; readonly more: PanelRect } | null;
};

/** The bottom strip's controls. `prev`/`next` are null on a one-page screen. */
export type MenuFooter = {
  readonly rect: PanelRect;
  readonly resetAll: PanelRect;
  readonly back: PanelRect;
  readonly prev: PanelRect | null;
  readonly next: PanelRect | null;
  /** "13–26 of 26", or "26 keys" when it all fits. Words and a count, never a bar. */
  readonly label: string;
};

/** What page of the Keys screen is on show. Pure arithmetic, exported for the test. */
export type MenuPaging = {
  readonly page: number;
  readonly pageCount: number;
  /** 1-based index of the first ACTION on this page, or 0 when none fits. */
  readonly first: number;
  readonly last: number;
  readonly total: number;
  readonly label: string;
};

type EscapeMenuGeometry = {
  readonly close: PanelRect;
  /** Rows in reading order, top to bottom. */
  readonly placed: readonly PlacedMenuRow[];
  /** The status line's box, or null when the panel had no room for one. */
  readonly status: PanelRect | null;
  readonly statusRow: Extract<MenuRow, { kind: typeof MenuRowKind.Status }> | null;
  readonly footer: MenuFooter | null;
  readonly paging: MenuPaging;
};

/**
 * FIT ROWS FROM `offset` INTO ONE PAGE, and say where the next page starts.
 *
 * ═══ ui/charsheet.ts:842-886, PORTED, WITH ITS ORPHAN RULE INTACT ═══
 * "TALENTS" at the foot of a column with all four talents at the top of the next
 * one is not a small ugliness: the heading labels the wrong thing, because the
 * reader's eye takes the rows UNDER a heading as belonging to it. The sheet
 * breaks to the next COLUMN; this breaks to the next PAGE, and the rule is
 * otherwise identical — a section carries the first row after it.
 *
 * IT NEVER PLACES HALF A ROW and never returns `offset` twice: the caller stops
 * when nothing at all fit, so a panel too small for one row cannot spin.
 */
function place(
  rows: readonly MenuRow[],
  offset: number,
  x: number,
  top: number,
  bottom: number,
  innerW: number,
): { readonly placed: readonly PlacedMenuRow[]; readonly next: number } {
  const placed: PlacedMenuRow[] = [];
  let cursor = top;
  let index = offset;

  for (; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    const h = rowHeight(row);
    if (cursor + h > bottom) break;

    // The orphan rule. It is a PREFERENCE and the overflow test above is a fact,
    // so they are separate: a heading is only pushed to the next page when
    // something has already been placed on this one, or a section whose first
    // row cannot fit anywhere would push pages forever.
    //
    // IT READS `heading`, NOT A KIND. The Journal's lore categories are `Note`
    // rows on purpose (`journalRows` argues it) and they label the rows under
    // them exactly as a `Section` does, so asking about the KIND let a category
    // be the last row on the panel with `N more — panel too small` directly
    // beneath it. Both kinds answer the same question now.
    const labels =
      row.kind === MenuRowKind.Section || (row.kind === MenuRowKind.Note && row.heading === true);
    if (labels && placed.length > 0) {
      const next = rows[index + 1];
      if (next !== undefined && cursor + h + rowHeight(next) > bottom) break;
    }

    const rowRect: PanelRect = { x, y: cursor, w: innerW, h };
    if (row.kind === MenuRowKind.Action && !row.locked) {
      const columns = keyColumns(rowRect);
      placed.push({
        row,
        rect: rowRect,
        slots: columns.slots,
        clear: columns.clear,
        reset: columns.reset,
        steppers: null,
      });
    } else if (row.kind === MenuRowKind.Entry && row.steppers !== undefined && row.enabled) {
      const columns = stepperColumns(rowRect);
      placed.push({
        row,
        rect: rowRect,
        slots: [],
        clear: null,
        reset: null,
        steppers: { less: columns.less, more: columns.more },
      });
    } else {
      placed.push({ row, rect: rowRect, slots: [], clear: null, reset: null, steppers: null });
    }
    cursor += h;
  }

  return { placed, next: index };
}

/** Where every page starts. Computed with the same `place` the geometry uses. */
function paginate(
  rows: readonly MenuRow[],
  x: number,
  top: number,
  bottom: number,
  innerW: number,
): readonly number[] {
  const starts: number[] = [0];
  let from = 0;
  while (from < rows.length) {
    const { next } = place(rows, from, x, top, bottom, innerW);
    // NOTHING FIT. The panel is too small for even one row; stop rather than
    // adding an empty page for every remaining row.
    if (next === from) break;
    if (next >= rows.length) break;
    starts.push(next);
    from = next;
  }
  return starts;
}

/** How many ACTION rows are in a slice. The pager counts keys, not lines. */
function countActions(rows: readonly MenuRow[], from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i += 1) {
    if (rows[i]?.kind === MenuRowKind.Action) n += 1;
  }
  return n;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AN EMPTY SECTION IS THE FIRST THING TO GO WHEN THE PANEL IS SHORT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══ THE REGRESSION THIS REPAIRS, MEASURED THROUGH THE REAL HIT TEST ═══
 * The Journal added a `QUESTS` heading, a `NOTES` heading and one empty-quests
 * line to the screen Case Notes used to be — 48 pixels — on a surface with NO
 * PAGER AND NO SCROLL. At 640x320, the DECLARED FLOOR, that turned "5 of the 5
 * notes reachable" into 3, and 3 into 1 with a fight on. The old screen needed a
 * 184-pixel band to show everything and the new one needed 232, so every window
 * under about 352 logical pixels tall lost rows a player could previously read.
 * A rename is not allowed to cost content.
 *
 * ═══ AND THE RULE IS THE ONE HONEST ONE ═══
 * The row that goes is the one carrying no information a player came for: the
 * placeholder under a section with nothing in it, and — because a heading with
 * neither contents nor placeholder is worse than no heading — the heading with
 * it. A section with REAL rows is never touched, so `QUESTS` appears the instant
 * there is a quest, at every viewport, which is the deliverable.
 *
 * ALL OR NOTHING, AND ONLY WHEN IT DOES NOT FIT. The pairs are cheap to
 * identify and expensive to rank — dropping "the least useful one first" would
 * mean this function had an opinion about which empty section matters — so it
 * asks one question, once. And it never returns an empty body: if EVERY section
 * is empty the whole panel is four rows and could not have overflowed anyway,
 * but the guard is written down rather than argued.
 *
 * WHY NOT A PAGER. This screen has never had one. The footer that carries PREV
 * and NEXT also carries RESET ALL, which belongs to the Keys screen and to
 * nothing else, so giving the Journal a pager means giving it a control that
 * either lies or has to be made optional across four call sites. That is a
 * change worth making the day quests are real and the list is long; it is not
 * what the floor viewport needs today.
 */
function dropEmptySections(rows: readonly MenuRow[], room: number): MenuRow[] {
  const wants = rows.reduce((sum, row) => sum + rowHeight(row), 0);
  if (wants <= room) return [...rows];
  const out: MenuRow[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row === undefined) continue;
    const next = rows[i + 1];
    if (
      row.kind === MenuRowKind.Section &&
      next !== undefined &&
      next.kind === MenuRowKind.Note &&
      next.placeholder === true
    ) {
      i += 1;
      continue;
    }
    out.push(row);
  }
  return out.length === 0 ? [...rows] : out;
}

/**
 * EVERYTHING INSIDE THE PANEL, IN ONE PASS. The painter's only source of truth
 * about where a row lands, and the owner of the paging policy.
 *
 * IT TAKES NO CONTEXT, which is what lets the hit test read it: ui/contextmenu.ts
 * :24-34 records why a hit test may not hold one — it would have to remember a
 * rect from the last frame, and a surface that has never been drawn would then
 * swallow clicks at 0,0.
 *
 * THE STATUS AND FOOTER STRIPS ARE RESERVED FROM THE RECT, NOT FROM THE
 * CONTENTS, which is ui/inventory.ts:145-151's rule: if they appeared when there
 * was something to say, the rows above would reflow at that instant and the row
 * under the pointer would move because it was pointed at.
 */
function escapeMenuGeometry(rect: PanelRect, rows: readonly MenuRow[]): EscapeMenuGeometry {
  const close = closeRect(rect);
  const x = rect.x + INSET;
  const innerW = Math.max(0, rect.w - INSET * 2);
  const top = rect.y + HEADER_H + INSET;
  const bottom = rect.y + rect.h - INSET;

  let statusLine: Extract<MenuRow, { kind: typeof MenuRowKind.Status }> | null = null;
  let footerLine: Extract<MenuRow, { kind: typeof MenuRowKind.Footer }> | null = null;
  const full: MenuRow[] = [];
  for (const row of rows) {
    if (row.kind === MenuRowKind.Status) statusLine = row;
    else if (row.kind === MenuRowKind.Footer) footerLine = row;
    else full.push(row);
  }
  const body = dropEmptySections(full, bottom - top);

  // ROOM FOR A STRIP MEANS ROOM FOR THE STRIP AND ONE ROW. A panel that spent
  // its whole height on the footer would be a screen with controls and nothing
  // to control.
  let limit = bottom;
  let footerRect: PanelRect | null = null;
  if (footerLine !== null && limit - top >= FOOTER_H + ROW_H) {
    footerRect = { x, y: limit - FOOTER_H, w: innerW, h: FOOTER_H };
    limit -= FOOTER_H;
  }
  let statusRect: PanelRect | null = null;
  if (statusLine !== null && limit - top >= STATUS_H + ROW_H) {
    statusRect = { x, y: limit - STATUS_H, w: innerW, h: STATUS_H };
    limit -= STATUS_H;
  }

  // ═══ THE NOTE'S LINE IS RESERVED ONLY WHEN THERE IS GOING TO BE A NOTE ═══
  // ui/talents.ts:478-484 verbatim, and only on the screen that has no pager: a
  // per-row lookahead would hold twelve pixels back on a panel where everything
  // fits, and the last entry — the one the drop policy exists to protect — would
  // be dropped to make room for a message saying it had been dropped.
  if (footerLine === null) {
    const wants = body.reduce((sum, row) => sum + rowHeight(row), 0);
    if (top + wants > limit) limit -= NOTE_ROW_H;
  }

  const starts = paginate(body, x, top, limit, innerW);
  const wanted = footerLine?.page ?? 0;
  const page = Math.min(Math.max(0, Math.trunc(wanted)), starts.length - 1);
  const start = starts[page] ?? 0;
  const laid = place(body, start, x, top, limit, innerW);

  const total = countActions(body, 0, body.length);
  const before = countActions(body, 0, start);
  const shown = countActions(body, start, laid.next);
  const first = shown === 0 ? 0 : before + 1;
  const last = before + shown;
  const paging: MenuPaging = {
    page,
    pageCount: starts.length,
    first,
    last,
    total,
    // WORDS AND A COUNT (ui/caselog.ts:464-478), never a bar and never a shade.
    // On a one-page screen the range would be the whole list, which says nothing
    // the list does not; the bare count is still worth a line, because "how many
    // keys are there" is the question a player scanning for one is asking.
    label:
      shown === 0
        ? 'no room for a single key — make the window taller'
        : starts.length <= 1
          ? `${String(total)} keys`
          : `${String(first)}–${String(last)} of ${String(total)}`,
  };

  const placed: PlacedMenuRow[] = [...laid.placed];

  // ═══ WHAT DID NOT FIT IS SAID OUT LOUD ═══
  // On the Keys screen the pager already says it, in more useful words. On the
  // root screen there is no pager, so a NOTE takes the last line — ui/talents.ts
  // :508-515 and ui/caselog.ts:464-478's rule that a surface which has quietly
  // stopped showing everything must never make the reader infer it.
  if (footerLine === null && laid.next < body.length) {
    const dropped = body.length - laid.next;
    const cursor = laid.placed.reduce((y, entry) => Math.max(y, entry.rect.y + entry.rect.h), top);
    if (cursor + NOTE_ROW_H <= bottom) {
      placed.push({
        row: {
          kind: MenuRowKind.Note,
          text:
            dropped === 1
              ? '1 more — panel too small'
              : `${String(dropped)} more — panel too small`,
        },
        rect: { x, y: cursor, w: innerW, h: NOTE_ROW_H },
        slots: [],
        steppers: null,
        clear: null,
        reset: null,
      });
    }
  }

  let footer: MenuFooter | null = null;
  if (footerRect !== null) {
    const y = footerRect.y + Math.floor((FOOTER_H - BTN_H) / 2);
    const right = footerRect.x + footerRect.w;
    const paged = paging.pageCount > 1;
    footer = {
      rect: footerRect,
      resetAll: { x: footerRect.x, y, w: RESET_ALL_W, h: BTN_H },
      back: { x: footerRect.x + RESET_ALL_W + CTRL_GAP, y, w: BACK_W, h: BTN_H },
      prev: paged ? { x: right - PAGE_BTN_W * 2 - CTRL_GAP, y, w: PAGE_BTN_W, h: BTN_H } : null,
      next: paged ? { x: right - PAGE_BTN_W, y, w: PAGE_BTN_W, h: BTN_H } : null,
      label: paging.label,
    };
  }

  return { close, placed, status: statusRect, statusRow: statusLine, footer, paging };
}

/**
 * THE PAGING ARITHMETIC ON ITS OWN, for a caller — or a test — that needs to
 * reason about pages without painting.
 *
 * It calls the SAME geometry the painter and the hit test call, so there is no
 * second copy of the sums. This is the only window onto the geometry that is
 * exported at all: everything else about it reaches the outside world as a
 * placed row or as a hit.
 */
export function escapeMenuPaging(rect: PanelRect, rows: readonly MenuRow[]): MenuPaging {
  return escapeMenuGeometry(rect, rows).paging;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ENTRY INDICES A KEYBOARD MAY LAND ON: THE ONES THAT ARE ACTUALLY DRAWN.
 * ═══════════════════════════════════════════════════════════════════════════
 * The selection used to be walked over the whole ROW LIST, and the geometry
 * truncates — `N more — panel too small`. So on a short panel the arrows and
 * WASD could move the marker onto a row nobody can see, and Enter then unfolded
 * an invisible note or ran the effect of a row that is not on the screen. A
 * control that answers nothing visible is this file's worst failure mode, stated
 * in `runMenuEffect`'s neighbourhood; here it was the keyboard reaching past the
 * edge of the panel.
 *
 * SAME GEOMETRY AS THE PAINTER AND THE HIT TEST, so the keyboard can reach
 * exactly what the pointer can reach and not one row more. That is the whole
 * reason this is a window onto `escapeMenuGeometry` rather than a filter the
 * caller writes: a second opinion about which rows are on screen is the bug.
 *
 * IN READING ORDER, because that is the order a selection walks.
 */
export function escapeMenuVisibleEntries(
  rect: PanelRect,
  rows: readonly MenuRow[],
): readonly number[] {
  const out: number[] = [];
  for (const placed of escapeMenuGeometry(rect, rows).placed) {
    if (placed.row.kind === MenuRowKind.Entry && placed.row.enabled) out.push(placed.row.index);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

export const MenuHitKind = {
  /** The × on the header. The mouse's copy of the key that opened the menu. */
  Close: 'close',
  /** A root entry. Only ever returned for an ENABLED one. */
  Entry: 'entry',
  /** A key column. The caller ARMS a capture on `{actionId, slot}`. */
  Rebind: 'rebind',
  /** `[X]` — clear BOTH slots of this action. */
  Clear: 'clear',
  /** `[D]` — put this action back on its shipped defaults. */
  Reset: 'reset',
  /** RESET ALL. The whole overlay goes; every action returns to its default. */
  ResetAll: 'reset_all',
  /** BACK. To the root screen; it is not the way out of the menu. */
  Back: 'back',
  /** PREV / NEXT. `delta` is -1 or +1. */
  Page: 'page',
  /**
   * The header strip, minus the × carved out of its right end: the DRAG HANDLE.
   *
   * IT IS NOT A MEMBER OF `MenuHit`, DELIBERATELY — see `MenuDrag` below.
   */
  Header: 'header',
} as const;
export type MenuHitKind = (typeof MenuHitKind)[keyof typeof MenuHitKind];

export type MenuHit =
  | { readonly kind: typeof MenuHitKind.Close }
  | {
      readonly kind: typeof MenuHitKind.Entry;
      readonly index: number;
      readonly effect: MenuEffect;
    }
  | {
      readonly kind: typeof MenuHitKind.Rebind;
      readonly actionId: string;
      readonly slot: number;
    }
  | { readonly kind: typeof MenuHitKind.Clear; readonly actionId: string }
  | { readonly kind: typeof MenuHitKind.Reset; readonly actionId: string }
  | { readonly kind: typeof MenuHitKind.ResetAll }
  | { readonly kind: typeof MenuHitKind.Back }
  | { readonly kind: typeof MenuHitKind.Page; readonly delta: number };

/**
 * WHAT A PRESS ON THE HEADER MEANS — a second reader over the SAME geometry,
 * not a ninth branch of `MenuHit`.
 *
 * ═══ THE SPLIT IS FORCED BY THE GATE, AND ui/inventory.ts:1270-1300 HIT IT
 *     FIRST ═══
 * main.ts's `runMenuHit` is a `switch (hit.kind)` with no `default`, under
 * `@typescript-eslint/switch-exhaustiveness-check` configured with
 * `allowDefaultCaseForExhaustiveSwitch: false` and
 * `considerDefaultExhaustiveForUnions: false` (eslint.config.js). Adding a ninth
 * member to `MenuHit` is therefore a LINT FAILURE in a file this menu does not
 * own, for an outcome the click path has nothing to do with — and `npm run
 * check` runs lint. So `MenuHit` keeps its eight click outcomes and stays total,
 * and the press gets its own reader. ui/talents.ts does the same thing for the
 * same reason one rule over; ui/charsheet.ts does not need to, because its hit
 * test answers a plain string union nobody switches on.
 *
 * BOTH READ THE SAME `closeRect`. There is still exactly one copy of where the
 * × is, which is the property ui/partypanel.ts:93-99 records the cost of losing.
 */
export type MenuDrag = { readonly kind: typeof MenuHitKind.Header };

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
 * pressing × and twitching two pixels must CLOSE the menu, not move it — and on
 * this panel in particular, the × is the way out for a player who has just made
 * a mess of their keyboard, so it is the last control that may be ambiguous.
 *
 * It takes no rows: the handle and the × both depend on the panel rect alone.
 * That is what lets a caller ask this question on `mousedown` without rebuilding
 * twenty-six key rows and four formatted strings each, per event.
 */
export function escapeMenuDragAt(rect: PanelRect, px: number, py: number): MenuDrag | null {
  const inside = (r: PanelRect): boolean =>
    px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
  if (inside(closeRect(rect))) return null;
  if (inside(headerHandle(rect))) return { kind: MenuHitKind.Header };
  return null;
}

/**
 * What a LOGICAL backbuffer point is over, or null.
 *
 * NULL MEANS "ON THE PANEL, BUT NOT ON ANYTHING" and never "fall through" — the
 * caller swallows the click either way, exactly as it does for the character
 * sheet. A GREYED ENTRY AND A LOCKED KEY ROW BOTH ANSWER NULL: a row that is
 * drawn as unpressable must be unpressable, and making that a property of the
 * geometry rather than a test in the caller is what stops it being forgotten.
 *
 * NESTED CONTROLS ARE TESTED BEFORE THE ROW THEY SIT IN, or the columns would be
 * unreachable while looking perfectly pressable. It reads the SAME geometry the
 * painter drew with, which is the whole reason `escapeMenuGeometry` takes no
 * context.
 */
export function escapeMenuHitAt(
  rect: PanelRect,
  rows: readonly MenuRow[],
  px: number,
  py: number,
): MenuHit | null {
  const inside = (r: PanelRect): boolean =>
    px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;

  const geometry = escapeMenuGeometry(rect, rows);
  if (inside(geometry.close)) return { kind: MenuHitKind.Close };

  const footer = geometry.footer;
  if (footer !== null) {
    if (inside(footer.resetAll)) return { kind: MenuHitKind.ResetAll };
    if (inside(footer.back)) return { kind: MenuHitKind.Back };
    if (footer.prev !== null && inside(footer.prev)) {
      return { kind: MenuHitKind.Page, delta: -1 };
    }
    if (footer.next !== null && inside(footer.next)) {
      return { kind: MenuHitKind.Page, delta: 1 };
    }
  }

  for (const placed of geometry.placed) {
    const row = placed.row;

    if (row.kind === MenuRowKind.Action) {
      for (let slot = 0; slot < placed.slots.length; slot += 1) {
        const box = placed.slots[slot];
        if (box === undefined || !inside(box)) continue;
        return { kind: MenuHitKind.Rebind, actionId: row.actionId, slot };
      }
      if (placed.clear !== null && inside(placed.clear)) {
        return { kind: MenuHitKind.Clear, actionId: row.actionId };
      }
      if (placed.reset !== null && inside(placed.reset)) {
        return { kind: MenuHitKind.Reset, actionId: row.actionId };
      }
      continue;
    }

    if (row.kind === MenuRowKind.Entry && row.enabled) {
      /**
       * THE ARROWS BEFORE THE ROW THEY SIT IN, exactly as the key columns are
       * tested before their action row: the other order leaves them drawn,
       * pressable-looking and unreachable, because the row's own rect covers
       * them and would answer first.
       *
       * ═══ AN ARROW AT THE END OF THE RANGE ANSWERS NOTHING ═══
       * It used to do the OPPOSITE of what it drew. The note here read *"falls
       * through to the ROW rather than answering null, and that is deliberate:
       * the row's own effect CYCLES, so a player who presses the greyed ▶ gets
       * the wrap they would have got from Enter"*. Driven at 1920x1080, that
       * wrap is what it costs: ▶, ▶ took the interface 100 -> 200 -> 300%, and
       * a third press on the GREYED ▶ took it straight back down to 100. The
       * arrow says "no further this way" and moved it the other way, by the
       * whole range, on the press that means "more".
       *
       * So the box is claimed and nothing happens, which is what a greyed
       * control means everywhere else here (`PlacedMenuRow.slots`: a control
       * drawn as unpressable must BE unpressable). THE CYCLE SURVIVES ON THE
       * ROW'S ENTER — `pressMenuSelection` still gives the row one act and it
       * still wraps, so a keyboard-only player is not stranded at the top.
       */
      const steppers = placed.steppers;
      if (steppers !== null && row.steppers !== undefined) {
        if (inside(steppers.less)) {
          return row.steppers.less
            ? { kind: MenuHitKind.Entry, index: row.index, effect: { kind: 'ui-scale', delta: -1 } }
            : null;
        }
        if (inside(steppers.more)) {
          return row.steppers.more
            ? { kind: MenuHitKind.Entry, index: row.index, effect: { kind: 'ui-scale', delta: 1 } }
            : null;
        }
      }
      if (inside(placed.rect)) {
        return { kind: MenuHitKind.Entry, index: row.index, effect: row.effect };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

/**
 * ONE OF THE UI SIZE ROW'S ARROWS: the same plate every button in this client
 * wears, with a TRIANGLE drawn on it instead of a character.
 *
 * `dir` is -1 for the left arrow and +1 for the right. See `STEP_ARROW_W` for
 * why it is a shape; `drawCog` in ui/caselog.ts is the precedent.
 *
 * THE PLATE COMES FROM `drawButton` WITH AN EMPTY LABEL rather than from four
 * `fillRect`s written out again here. A second copy of the border arithmetic is
 * how one button in a panel comes to look a pixel different from its neighbour.
 */
function drawStepArrow(
  ctx: CanvasRenderingContext2D,
  rect: PanelRect,
  dir: -1 | 1,
  opts: { readonly ink: string },
): void {
  if (rect.w <= 0 || rect.h <= 0) return;
  drawButton(ctx, rect, '', opts);
  const w = Math.min(STEP_ARROW_W, rect.w - 2);
  const h = Math.min(STEP_ARROW_H, rect.h - 2);
  if (w <= 0 || h <= 0) return;
  // WHOLE PIXELS. The backbuffer is magnified nearest-neighbour, so a triangle
  // on a half pixel is a triangle with one soft edge and one hard one.
  const cx = Math.floor(rect.x + rect.w / 2);
  // FLOORED, NOT ROUNDED. The plate is 11 tall, so rounding puts the centre a
  // pixel low and the triangle's bottom point lands ON the border row.
  const cy = Math.floor(rect.y + rect.h / 2);
  const tip = cx + (dir === 1 ? Math.ceil(w / 2) : -Math.ceil(w / 2));
  const base = cx - (dir === 1 ? Math.floor(w / 2) : -Math.floor(w / 2));
  ctx.save();
  ctx.fillStyle = opts.ink;
  ctx.beginPath();
  ctx.moveTo(tip, cy);
  ctx.lineTo(base, cy - Math.floor(h / 2));
  ctx.lineTo(base, cy + Math.floor(h / 2));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** The status line's marker. A SHAPE per tone, so the three survive greyscale. */
function markerFor(tone: MenuTone): string {
  switch (tone) {
    case MenuTone.Armed:
      return '»';
    case MenuTone.Warn:
      return '!';
    case MenuTone.Quiet:
      return '·';
  }
}

function inkFor(tone: MenuTone): string {
  switch (tone) {
    case MenuTone.Armed:
      return PALETTE.GOLD;
    case MenuTone.Warn:
      return PALETTE.ORANGE;
    case MenuTone.Quiet:
      return PALETTE.GREY_HI;
  }
}

/** A right-aligned grey annotation inside the name column. One copy, two meanings. */
function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  text: string,
  rowRect: PanelRect,
  nameW: number,
  nameUsed: number,
  ink: string,
): void {
  if (text === '') return;
  const room = Math.max(0, nameW - nameUsed - CHAR_W);
  if (room <= 0) return;
  ctx.font = FONT_BODY;
  ctx.textAlign = 'right';
  ctx.fillStyle = ink;
  ctx.fillText(fitText(ctx, text, room), rowRect.x + nameW, rowRect.y + ROW_H / 2);
  ctx.textAlign = 'left';
}

/** One placed row. Every fill sets its own font immediately before it. */
function drawRow(
  ctx: CanvasRenderingContext2D,
  placed: PlacedMenuRow,
  hovered: number | null,
): void {
  const { row, rect } = placed;

  switch (row.kind) {
    case MenuRowKind.Entry: {
      const isHovered = hovered === row.index && row.enabled;
      // The plate first, so the label lands on something dark enough to read
      // against whatever the panel skin is.
      ctx.fillStyle = PALETTE.INK;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h - 2);
      const ink = !row.enabled ? PALETTE.GREY : isHovered ? PALETTE.GOLD : PALETTE.PARCHMENT;

      // THE HOVER MARKER IS A SHAPE. A row that is only brighter is a row a
      // player with the contrast turned down cannot find.
      ctx.font = FONT_META;
      ctx.fillStyle = ink;
      const mark = isHovered ? `${HOVER_MARK} ` : '  ';
      const label = `${mark}${row.label}`;
      ctx.fillText(fitText(ctx, label, rect.w - 4), rect.x + 2, rect.y + (rect.h - 2) / 2);

      /**
       * ═══ THE ARROWS AND THE NUMBER, WHERE THE KEY WOULD OTHERWISE GO ═══
       * One row carries them and it is the only Entry with anything inside it.
       * Drawn from `stepperColumns`, which is also what `place` built the hit
       * boxes from, so there is one opinion about where they are.
       *
       * ═══ A GREYED ROW STILL PRINTS THE NUMBER, WHICH THIS CLAIMED AND DID NOT DO
       * The note four screens up says *"STILL SHOWN, and still showing the
       * setting … a small window must say what is set"*, and this was gated on
       * `row.enabled` — so on the three windows this game is actually played
       * in, where `uiScaleFixed` is true, the row printed no percentage at all.
       * A comment claiming behaviour the painter does not have is worse than
       * the missing feature, because the next reader believes it.
       *
       * SO BOTH, AND THE REASON MOVES LEFT OF THEM. The arrows are drawn GREY
       * (they are unpressable, and `place` builds no boxes for them), the
       * readout is drawn grey beside them, and "this window fits one size"
       * right-aligns against the arrows instead of against the row. Those are
       * not two controls competing for one strip: they are one fact and the
       * sentence explaining it.
       */
      const columns = row.steppers === undefined ? null : stepperColumns(rect);
      if (row.steppers !== undefined && columns !== null) {
        drawStepArrow(ctx, columns.less, -1, {
          ink: row.enabled && row.steppers.less ? PALETTE.PARCHMENT : PALETTE.GREY,
        });
        drawStepArrow(ctx, columns.more, 1, {
          ink: row.enabled && row.steppers.more ? PALETTE.PARCHMENT : PALETTE.GREY,
        });
        // THE VALUE IS TEXT, NOT A BUTTON. It is a readout and pressing it must
        // not look like it does something the arrows do.
        ctx.font = FONT_BODY;
        ctx.textAlign = 'center';
        ctx.fillStyle = row.enabled ? PALETTE.GOLD : PALETTE.GREY;
        ctx.fillText(
          fitText(ctx, row.steppers.value, columns.value.w),
          columns.value.x + columns.value.w / 2,
          columns.value.y + columns.value.h / 2,
        );
        ctx.textAlign = 'left';
        if (row.enabled) return;
      }

      // The key on the right — the live one. A greyed row says WHY instead,
      // because "you are a party of one" is the only thing a player can act on.
      const right = row.enabled ? row.keyLabel : (row.reason ?? '');
      if (right !== '') {
        ctx.font = FONT_BODY;
        ctx.textAlign = 'right';
        ctx.fillStyle = row.enabled ? PALETTE.GREY_HI : PALETTE.GREY;
        ctx.fillText(
          fitText(ctx, right, rect.w / 2),
          // LEFT OF THE ARROWS WHEN THERE ARE ANY, so the sentence and the
          // number sit side by side rather than one over the other.
          columns === null ? rect.x + rect.w - 3 : columns.less.x - 3,
          rect.y + (rect.h - 2) / 2,
        );
        ctx.textAlign = 'left';
      }
      return;
    }

    case MenuRowKind.Section: {
      ctx.font = FONT_META;
      ctx.fillStyle = PALETTE.GOLD;
      ctx.fillText(fitText(ctx, row.label, rect.w), rect.x, rect.y + SECTION_H - 6);
      // A rule under the heading, so the groups read as blocks in a column that
      // has no other structure. ui/charsheet.ts:1012-1013 draws the same one.
      ctx.fillStyle = PALETTE.SLATE;
      ctx.fillRect(rect.x, rect.y + SECTION_H - 1, rect.w, 1);
      return;
    }

    case MenuRowKind.Note: {
      ctx.font = FONT_BODY;
      ctx.fillStyle = PALETTE.GREY_HI;
      ctx.fillText(fitText(ctx, row.text, rect.w), rect.x, rect.y + NOTE_ROW_H / 2);
      return;
    }

    case MenuRowKind.Action: {
      const columns = keyColumns(rect);
      ctx.font = FONT_NAME;
      ctx.fillStyle = row.locked ? PALETTE.GREY_HI : PALETTE.PARCHMENT;
      const name = fitText(ctx, row.name, columns.nameW);
      ctx.fillText(name, rect.x, rect.y + ROW_H / 2);
      const nameUsed = Math.ceil(ctx.measureText(name).width);

      // THE ANNOTATION IS THE PERMANENT FLOOR, right-aligned in the name column:
      // a player who rewrote `w` can see that the numpad still walks them north,
      // which is otherwise the thing they report as broken.
      // A locked row has no annotation here — its floor is already in the
      // columns and its second line carries the reason instead.
      drawAnnotation(ctx, row.fixed, rect, columns.nameW, nameUsed, PALETTE.GREY_HI);

      // ═══ THE SECOND LINE OF A LOCKED ROW: A WORD, A DOT AND THE REASON ═══
      // Never a colour alone (ui/partypanel.ts:78-92) and never the word alone:
      // "LOCKED" tells a player they cannot, and only the reason stops them
      // filing it as a bug. Full width, because that is where it fits.
      //
      // ═══ AND ONLY WHEN THE ROW WAS PAID FOR IT ═══
      // `rowHeight` above buys the extra ten pixels for `row.reason !== null`,
      // NOT for `row.locked` — a row whose reason its GROUP already states has
      // nothing to put on line two, which is what `sharedLockReason` is for.
      // This gate asked the other question, so since the hotbar's reason moved
      // to its group, talent slots 2–9 painted the word `LOCKED ·` into the ten
      // pixels belonging to the NEXT row: eight overprinted names and a stray
      // `LOCKED ·` across the `Log` group heading. Found by a rendered contact
      // sheet, two rows under the new Journal row; it predates this run and is
      // the most visible thing on the screen this run changed.
      if (row.locked && row.reason !== null) {
        ctx.font = FONT_BODY;
        ctx.fillStyle = PALETTE.ORANGE;
        ctx.fillText(
          fitText(ctx, `${LOCKED_WORD} · ${row.reason}`, rect.w),
          rect.x,
          rect.y + ROW_H + (LOCKED_ROW_H - ROW_H) / 2,
        );
      }

      for (let slot = 0; slot < columns.slots.length; slot += 1) {
        const box = columns.slots[slot];
        if (box === undefined) continue;
        const text = row.slots[slot === 0 ? 0 : 1];
        if (row.locked) {
          // TEXT, NOT A BUTTON. A control that is drawn and refuses is worse
          // than one that is not drawn — and the hit test agrees, so a locked
          // column is not a target at all.
          ctx.font = FONT_BODY;
          ctx.textAlign = 'center';
          ctx.fillStyle = PALETTE.GREY;
          ctx.fillText(fitText(ctx, text, box.w), box.x + box.w / 2, box.y + box.h / 2);
          ctx.textAlign = 'left';
          continue;
        }
        const armed = row.armedSlot === slot;
        drawButton(ctx, box, armed ? ARMED_LABEL : text, {
          ink: armed ? PALETTE.GOLD : PALETTE.PARCHMENT,
        });
      }

      if (!row.locked) {
        drawButton(ctx, columns.clear, CLEAR_LABEL, { ink: PALETTE.GREY_HI });
        drawButton(ctx, columns.reset, RESET_LABEL, { ink: PALETTE.GREY_HI });
      }
      return;
    }

    // The two strips are placed from the RECT rather than from the row list, so
    // they are drawn by `drawEscapeMenu` itself and never arrive here.
    case MenuRowKind.Status:
    case MenuRowKind.Footer:
      return;
  }
}

export type EscapeMenuDrawOptions = {
  readonly ctx: CanvasRenderingContext2D;
  readonly sprites: SpriteSource;
  readonly rect: PanelRect;
  /** Decides the title only. The rows decide everything else. */
  readonly screen: MenuScreen;
  /** From `escapeMenuRows`. Passed in so the caller holds one copy per frame. */
  readonly rows: readonly MenuRow[];
  /** Highlights the close control, so it reads as pressable. */
  readonly hoveredClose: boolean;
  /** Root entry index under the pointer, or null. Cosmetic. */
  readonly hovered: number | null;
};

/**
 * Paint the menu.
 *
 * `save`/`restore` around everything because it sets `font`, `textAlign`,
 * `textBaseline` and `fillStyle`, none of which the world painter re-sets before
 * every call — a leak surfaces three milestones later as a mysteriously
 * right-aligned label somewhere else entirely. CLIPPED to its own rect for the
 * reason every panel here is: a long refusal sentence must never bleed onto the
 * map.
 *
 * IT DRAWS NO SCRIM. That is not an omission — it is the panel-not-modal
 * decision made visible. Everything behind it is still live and still pressable,
 * including the hotbar, so a player with this menu open can still take their
 * turn and the party waits for nobody.
 */
export function drawEscapeMenu(options: EscapeMenuDrawOptions): void {
  const { ctx, sprites, rect, screen, rows, hoveredClose, hovered } = options;
  if (rect.w <= 0 || rect.h <= 0) return;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  drawPanel(ctx, sprites, PanelSkin.CaseFile, rect);
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();

  drawHeader(ctx, sprites, menuTitle(screen), rect, FONT_META);

  const geometry = escapeMenuGeometry(rect, rows);
  for (const placed of geometry.placed) drawRow(ctx, placed, hovered);

  // ═══ THE STATUS LINE ═══
  // A plate, a MARKER and the sentence. The marker is what makes the three tones
  // survive greyscale; the plate is what makes an orange refusal legible over
  // whatever the panel skin is.
  const status = geometry.status;
  const statusRowLine = geometry.statusRow;
  if (status !== null && statusRowLine !== null) {
    ctx.fillStyle = PALETTE.INK;
    ctx.fillRect(status.x, status.y, status.w, status.h);
    ctx.font = FONT_BODY;
    ctx.fillStyle = inkFor(statusRowLine.tone);
    ctx.fillText(
      fitText(ctx, `${markerFor(statusRowLine.tone)} ${statusRowLine.text}`, status.w - 2),
      status.x + 2,
      status.y + status.h / 2,
    );
  }

  // ═══ THE FOOTER ═══
  const footer = geometry.footer;
  if (footer !== null) {
    drawButton(ctx, footer.resetAll, RESET_ALL_LABEL, { ink: PALETTE.ORANGE });
    drawButton(ctx, footer.back, BACK_LABEL, { ink: PALETTE.PARCHMENT });
    if (footer.prev !== null) drawButton(ctx, footer.prev, PREV_LABEL, { ink: PALETTE.PARCHMENT });
    if (footer.next !== null) drawButton(ctx, footer.next, NEXT_LABEL, { ink: PALETTE.PARCHMENT });

    // WORDS AND A COUNT, right-aligned against whichever control ends the strip.
    const rightEdge = footer.prev?.x ?? footer.rect.x + footer.rect.w;
    ctx.font = FONT_BODY;
    ctx.textAlign = 'right';
    ctx.fillStyle = PALETTE.GREY_HI;
    const room = Math.max(0, rightEdge - CTRL_GAP - (footer.back.x + footer.back.w) - CTRL_GAP);
    ctx.fillText(
      fitText(ctx, footer.label, room),
      rightEdge - CTRL_GAP,
      footer.rect.y + footer.rect.h / 2,
    );
    ctx.textAlign = 'left';
  }

  // The close control. Escape closes it too and always will — this is the
  // mouse's copy of the same act, and it is the only one a player whose keyboard
  // is in a state they regret can still reach.
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
export const ESCAPE_MENU_MIN_H = PANEL_MIN_H;
/** As above, for the width. */
export const ESCAPE_MENU_MIN_W = PANEL_MIN_W;
/** The air the panel leaves around itself inside its band. */
export const ESCAPE_MENU_MARGIN = PANEL_MARGIN;
