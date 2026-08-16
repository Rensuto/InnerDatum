/**
 * THE CHARACTER SHEET: everything the server knows about YOU, on one page.
 *
 * ===========================================================================
 * IT IS A DOCK PANEL, NOT A MODAL, AND THAT IS THE WHOLE DESIGN
 * ===========================================================================
 * ToME's `CharacterSheet.lua` is a registered dialog: `engine/Game.lua:380-381`
 * calls `d.key:setCurrent()` when a dialog opens, so the sheet SEIZES the entire
 * keyboard, and the sheet then rebinds nearly every letter for itself
 * (CharacterSheet.lua:271-303). ToME can afford that because ToME is single
 * player and the world is paused while you read.
 *
 * THIS GAME CANNOT. Five other people are at the barrier. Porting that focus
 * capture would mean one player reading their stats holds the whole party until
 * the Bell fires on them. So the sheet is a PANEL: it swallows no keys, no turn
 * verbs and no hotbar slots. A player reading it can still walk, still commit,
 * still hold, still press 1-4, and the server is never told it is open. The
 * consequence is deliberate and already handled by machinery that exists — a
 * player who reads instead of acting is exactly a player who is thinking, and
 * the Warrant Clock auto-passes them after the Bell like anyone else
 * (engine/barrier.ts).
 *
 * That single decision is why `charSheetRect` takes a BAND rather than a
 * viewport: clamped between `top` and `bottom`, the sheet can never come to rest
 * over the hotbar, the resource strip or the prose lines, so every control the
 * player might reach for stays visible and pressable underneath it.
 *
 * ===========================================================================
 * THE SECTION ORDER IS THE PORT. IT IS THE ONE THING THAT MUST NOT DRIFT
 * ===========================================================================
 * ToME's sheet is three tabs — General, Attack, Defense — plus a talents tab,
 * and the spine of it is:
 *
 *   GENERAL   identity, then Life, then the resource pools
 *             (CharacterSheet.lua:604-606 Sex/Race/Class, :625 "Life",
 *              :627-628 the `resources_def` loop)
 *   ATTACK    accuracy, damage, APR, crit
 *             (CharacterSheet.lua:935 "Accuracy", :941 "Damage")
 *   DEFENSE   armour, defence, then the three saves
 *             (CharacterSheet.lua:1303-1306 "Armor"/"Defense",
 *              :1316-1321 Physical/Spell/Mental)
 *   TALENTS   the talent tab
 *
 * Reduced to what this game has, that is: name -> class -> LEVEL -> EXPERIENCE
 * -> Life -> resource -> the server's own stat/attack/defense rows -> talents.
 *
 * ═══ LEVEL AND EXPERIENCE ARE HERE NOW, AND THAT PARAGRAPH USED TO SAY THEY
 *     COULD NOT BE ═══
 * This header used to list "level, xp, gold, equipment, inventory, inscriptions"
 * together as things ABSENT rather than shown as empty rows, on the grounds that
 * a row reading "Gold: 0" on a screen with no economy is a promise of a system
 * that does not exist. THAT PROMISE IS NOW KEPT for two of the six: v9 brought a
 * real experience curve, a real level and real talent points (src/shared/
 * progression.ts), so the rows describe a system a player can feel and are drawn
 * exactly where ToME draws them — CharacterSheet.lua:614-615 prints "Level:" and
 * "Exp  :" between the Class line at :606 and "Life" at :625, and the HUD frame
 * prints "Lvl N" beside the name in the identity block
 * (uiset/Minimalist.lua:1552-1560). Gold, equipment, inventory and inscriptions
 * are still absent, still for the original reason, and this sentence is the
 * reminder of what it takes to earn a row here.
 *
 * THE TALENT-POINTS ROW IS DIFFERENT IN KIND FROM BOTH and appears only while
 * `unspent > 0`. It is not a stat, it is a CALL TO ACTION — so it names the key
 * that answers it, and it goes away the moment there is nothing to answer. That
 * conditionality is ToME's own: uiset/Minimalist.lua:1512-1516 draws the levelup
 * glow, and :1587-1589 makes its hotspot clickable, only under
 * `player.unused_talents > 0 or ...`.
 *
 * ATTACK AND DEFENSE COLLAPSE INTO ONE SECTION HERE, and it is not laziness. The
 * server sends `InspectView.rows` as one ordered list and protocol.ts is explicit
 * that the order is the SERVER's to change; splitting it in the browser would
 * mean scanning for the label "Armour" to find the seam, which is the exact
 * fragility `className` was made a top-level field to avoid. So the fifteen rows
 * arrive in the server's order and are drawn in the server's order, UNSORTED,
 * under one heading.
 *
 * ===========================================================================
 * THE TALENT ROWS ARE COMPOSED HERE, FROM THREE FRAMES
 * ===========================================================================
 * `loadout` carries the four talents, `cooldowns` carries what is still cooling,
 * and neither is in `inspected`. Joining them in the browser is correct rather
 * than a shortcut: protocol.ts refuses to smuggle an asset key or a formatted
 * cooldown into an `InspectRow`, whose whole reason for being a {label, value}
 * pair is that the client owns presentation.
 *
 * THE FIELD ORDER INSIDE A TALENT ROW IS ToME'S TOOLTIP, NOT ITS TALENTS TAB.
 * `Actor:getTalentFullDescription` prints mode (Actor.lua:6219-6223), then the
 * resource costs (:6231-6259), then "Range:" (:6266-6267), then "Cooldown:"
 * (:6270). The talents TAB shows only a name and a level, which is useless to a
 * player deciding whether to press 3 right now. So: name, cost, range, cooldown.
 *
 * MODE IS DELIBERATELY ABSENT AND IS NOT INVENTED. `LoadoutTalent` has no mode
 * field — every talent this game ships is activated — so there is nothing to
 * colour-code by, and a colour keyed off `shape` would be a made-up taxonomy
 * wearing the authority of a ported one. When a sustain or a passive exists, the
 * field goes on the wire first and the colour follows it.
 *
 * ===========================================================================
 * ONE PAGE. NO TABS, NO SCROLLING, AND THE DROP IS SAID IN WORDS
 * ===========================================================================
 * No tabs because there is no key bound to change one and no room to draw four,
 * and because everything we have fits on a page. No scrolling because a scroll
 * position is state, state needs a scrollbar, a scrollbar needs a hit test, and
 * the entire sheet is thirty short rows.
 *
 * When it genuinely does not fit — a short viewport, a narrow window — a whole
 * SECTION is dropped and a row says so, taking ui/caselog.ts:467-478's rule that
 * a surface which has quietly stopped showing everything must never make the
 * reader infer it. Sections are dropped least-important first (see DROP_ORDER),
 * never truncated mid-list: half of the stat block is worse than none of it,
 * because the reader cannot tell which half they are missing.
 *
 * ===========================================================================
 * GEOMETRY IS PURE, AND THE PAINTER AND THE POINTER READ THE SAME COPY
 * ===========================================================================
 * `closeRect` is called by `drawCharSheet` AND by `charSheetHitAt`, for the
 * reason ui/partypanel.ts:93-99 records: two copies of this arithmetic is how a
 * button lands one row above where it is drawn, and the bug only shows up on
 * somebody else's window size. Neither takes a context — ui/contextmenu.ts:24-34
 * states why that matters: a hit test that needed a context would have to
 * remember a rect from the last frame, and a surface that has never been drawn
 * would then swallow clicks at 0,0.
 *
 * Box sizes come from a CHAR_W character-count estimate, exactly as
 * ui/tooltip.ts:69-74 does; the actual strings then go through `fitText` against
 * the real inner width at paint time. Nothing here positions one string against
 * another from a character count.
 *
 * It draws into the BACKBUFFER at logical scale like every other ui/ module —
 * see the long note at the top of render/canvas.ts.
 */

import { ResourceKind, TalentShape } from '../../shared/protocol.ts';
import { PALETTE } from '../render/canvas.ts';
import { gameKeymap } from '../input/keys.ts';
import { labelFor } from '../input/keymap.ts';
import {
  drawButton,
  drawHeader,
  drawPanel,
  fitText,
  HEADER_H,
  PANEL_PAD,
  PanelSkin,
} from './panel.ts';
import type {
  InspectView,
  LoadoutTalent,
  ProgressMsg,
  ResourceView,
} from '../../shared/protocol.ts';
import type { Keymap } from '../input/keymap.ts';
import type { SpriteSource } from '../render/assets.ts';
import type { PanelRect } from './panel.ts';

// ---------------------------------------------------------------------------
// Geometry constants. See the header before changing any of them.
// ---------------------------------------------------------------------------

/**
 * Advance of one glyph in the 10px monospace this file draws with. The same six
 * pixels ui/tooltip.ts:69-74 and ui/contextmenu.ts:161 use, and for the same
 * reason: it decides how big a BOX is and nothing else.
 */
const CHAR_W = 6;

/** One label/value line. 10px glyphs with 2px of leading, matching the Case Log. */
const ROW_H = 12;
/** A section heading: the same line, plus air above it and a rule under it. */
const SECTION_H = 18;
/**
 * A talent line. Tall enough for an icon box beside two stacked half-lines —
 * the name on top, then cost / range / cooldown.
 */
const TALENT_H = 22;
/** The icon box on a talent row. See `drawTalentIcon` for why it is this small. */
const TALENT_ICON = 18;

/** Chrome lost on each side. Mirrors `panelInner`'s inset, as ui/tooltip.ts does. */
const INSET = PANEL_PAD + 3;
/** The gutter between the two columns, when there are two. */
const COL_GAP = 10;

/**
 * The narrowest inner width that earns a second column.
 *
 * Below it, two columns are two columns of ellipses: the longest label the
 * server sends is "Physical save" at 13 characters and the widest value is the
 * damage band, so a column under ~22 characters stops being able to show a
 * label and its value on one line at all.
 */
const TWO_COL_MIN_W = 22 * 2 * CHAR_W + COL_GAP;

/** Preferred and minimum size of the panel itself. */
const SHEET_W = 328;
const SHEET_MIN_W = 168;
const SHEET_MAX_H = 268;
/**
 * A sheet shorter than a header plus the identity block is not worth drawing.
 *
 * ═══ IT IS DERIVED, AND LEAVING IT STALE IS A PANEL THAT NEVER OPENS ═══
 * FIVE identity rows now, not three: Name, Class, Level, Experience, Life. The
 * talent-points row is deliberately NOT counted — it is conditional, and sizing
 * the minimum for a row that is usually absent would refuse to draw a perfectly
 * good sheet on a short viewport. This number gates `charSheetRect`, so a copy
 * left at three would let the panel open into a band that cannot hold what
 * `charSheetRows` now returns; a copy left too large makes the sheet report null
 * and never draw at all. Exported so the test can pin the bottom of the range
 * instead of spelling the arithmetic a second time.
 */
export const SHEET_MIN_H = HEADER_H + INSET * 2 + SECTION_H + ROW_H * 5;
/** Air between the panel and the edges of the band it is clamped into. */
const SHEET_MARGIN = 6;

/** The close control, top-right of the header strip. Square, so it is a target. */
const CLOSE_PX = 13;
/**
 * The control that opens the talent panel, left of the close. THE PORTED HALF of
 * decision (h): ToME's own discoverable route to its levelup screen is a BUTTON
 * on the character sheet — `Button.new{text="[L]evelup", ...}` at
 * dialogs/CharacterSheet.lua:99, whose `fct` triggers the LEVELUP virtual action
 * — and the bracketed-letter grammar is the same one it uses for
 * "Manage [I]nventory" at :95.
 *
 * OURS NAMES OUR KEY RATHER THAN ToME'S, WHICH IS THE WHOLE POINT OF A MNEMONIC:
 * `l` is Dir.E in this game and the keymap's `move_east` row says at length why
 * that cannot move.
 *
 * ═══ AND IT IS READ LIVE, BECAUSE IT USED TO BE THE LITERAL '[G]' ═══
 * The letter is a DEFAULT now, not a fact: `show_talents` is rebindable, so a
 * hard-coded `[G]` becomes a lie the first time somebody uses the Keys screen —
 * and a mnemonic that names the wrong key is worse than no mnemonic at all,
 * because the player believes it and presses it. `keyMnemonic` reads the live
 * keymap on every frame, and answers `--` when the player has genuinely left the
 * panel with no key, which is a truth they need rather than a blank.
 *
 * WIDE ENOUGH FOR FOUR CHARACTERS, since the label is no longer known at compile
 * time: `[G]` is three, `[--]` is four, and anything longer is trimmed by
 * `drawButton`'s own `fitText`.
 */
const TALENTS_BTN_W = 30;
/** Air between the two header controls, so neither swallows the other's click. */
const HEADER_BTN_GAP = 3;

/**
 * THE KEY AN ACTION ANSWERS TO, AS ONE SHORT LABEL FOR A BUTTON OR A SENTENCE.
 *
 * `labelFor` gives EVERY binding including the frozen floor — "K / Up / Num8" —
 * which is right on a row of the Keys screen and far too long for a 30-pixel
 * button, so this takes the first. It is already '--' when the action has no key
 * at all (KeyBind.lua:158-160's own first line, ported in keymap.ts).
 */
function keyMnemonic(actionId: string, keymap: Keymap): string {
  return labelFor(actionId, keymap).split(' / ')[0] ?? '--';
}

const FONT_LABEL = '10px ui-monospace, Consolas, monospace';
const FONT_VALUE = 'bold 10px ui-monospace, Consolas, monospace';
const FONT_SECTION = 'bold 10px ui-monospace, Consolas, monospace';
const FONT_META = '10px ui-monospace, Consolas, monospace';
/** The first-letter fallback inside a talent icon box. Non-violet, by rule. */
const FONT_ICON_FALLBACK = 'bold 11px ui-monospace, Consolas, monospace';

/** The title on the header strip. ToME calls the screen the same thing. */
const SHEET_TITLE = 'CHARACTER';

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * The four kinds of line the sheet can hold.
 *
 * A const object plus a derived type rather than an `enum`: `erasableSyntaxOnly`
 * is on and an enum emits runtime code the type-stripping loader refuses.
 */
export const SheetRowKind = {
  /** A heading with a rule under it. Never a click target. */
  Section: 'section',
  /** A label on the left, a value on the right. The workhorse. */
  Field: 'field',
  /** Icon, name, and the cost/range/cooldown line. */
  Talent: 'talent',
  /** A sentence about the sheet itself — "gathering…", or what was dropped. */
  Note: 'note',
} as const;
export type SheetRowKind = (typeof SheetRowKind)[keyof typeof SheetRowKind];

/**
 * The three section headings, as words.
 *
 * Exported because the section ORDER is the ported contract (see the header) and
 * the test that pins it must be able to name the sections without copying string
 * literals out of this file — a test that spelled them itself would keep passing
 * while the sheet drew them in the wrong order.
 */
export const SheetSection = {
  General: 'GENERAL',
  /** ToME's Attack and Defense tabs, collapsed. See the header for why. */
  Combat: 'COMBAT',
  Talents: 'TALENTS',
} as const;
export type SheetSection = (typeof SheetSection)[keyof typeof SheetSection];

export type SheetRow =
  | { readonly kind: typeof SheetRowKind.Section; readonly label: SheetSection }
  | { readonly kind: typeof SheetRowKind.Field; readonly label: string; readonly value: string }
  | {
      readonly kind: typeof SheetRowKind.Talent;
      readonly name: string;
      /** An asset KEY off the wire, never derived from the name. */
      readonly icon: string;
      /** "AP 5 · 2 Focus", or "free". Composed here — see the header. */
      readonly cost: string;
      /** "3–7", "melee/personal" or "self". ToME's own wording where it has one. */
      readonly range: string;
      /** "ready", "1 turn" or "3 turns". */
      readonly cooldown: string;
      /** Carried so the painter can mark ready with a WORD and a colour, not one. */
      readonly ready: boolean;
    }
  | { readonly kind: typeof SheetRowKind.Note; readonly text: string };

/**
 * Everything the sheet is built from. Four frames, none of which is enough alone.
 *
 * `view` IS THE VIEWER'S OWN `inspected` AND MUST BE. inspect.ts splits three
 * ways and only the self branch carries the stat block and `className`; asking
 * about a teammate comes back with exactly two rows, and this panel would then
 * draw an almost-empty sheet with somebody else's name on it.
 */
export type CharSheetView = {
  /** Null while the `inspect` round trip is out — see the gathering row below. */
  readonly view: InspectView | null;
  /** The viewer's own pool, from the `resource` frame. Null before it arrives. */
  readonly resource: ResourceView | null;
  /** The `loadout` frame, in HOTBAR ORDER. Never sorted here. */
  readonly loadout: readonly LoadoutTalent[];
  /** The `cooldowns` frame: talent id -> turns left. Absent means READY. */
  readonly cooldowns: Readonly<Record<string, number>>;
  /**
   * The `progress` frame (v9): level, xp into it, the next threshold, and the
   * points in hand. NULL BEFORE THE FIRST ONE ARRIVES, which is a real window —
   * it is sent in the `hello` block, so the sheet can be opened for one frame
   * before it lands. Null means "no level line", never "level 0".
   */
  readonly progress: ProgressMsg | null;
  /**
   * The player's compiled keymap, for the two places this sheet names a KEY.
   *
   * OPTIONAL, AND IT DEFAULTS TO THE LIVE ONE. `gameKeymap` is the box
   * `bindGameKeys` already dereferences on every press, so the sheet and the
   * dispatcher cannot disagree about which key opens the talent panel, and
   * main.ts's existing call site needed no change at all. A caller with a
   * private keymap — a preview, a test — passes that instead.
   */
  readonly keymap?: Keymap;
};

/** The word for a pool. A switch, so a fourth `ResourceKind` is a compile error. */
function resourceLabel(kind: ResourceKind): string {
  switch (kind) {
    case ResourceKind.Resolve:
      return 'Resolve';
    case ResourceKind.Focus:
      return 'Focus';
    case ResourceKind.Reagents:
      return 'Reagents';
  }
}

/**
 * What one use costs, as one string.
 *
 * ToME lists every non-zero resource on its own line and omits the zeros
 * entirely (Actor.lua:6236-6243: `if cost ~= 0 then ... end`). Same rule, one
 * line: a talent that costs nothing says "free" rather than showing three zeros,
 * because three zeros read as "unknown" at a glance.
 */
function costText(talent: LoadoutTalent, resource: ResourceView | null): string {
  const parts: string[] = [];
  if (talent.cost.ap > 0) parts.push(`AP ${talent.cost.ap}`);
  if (talent.cost.mp > 0) parts.push(`MP ${talent.cost.mp}`);
  if (talent.cost.resource > 0) {
    // The POOL'S NAME when we know it, the bare number when we do not. The
    // `resource` frame is unicast and arrives beside the loadout, so the null is
    // a one-frame window on connect rather than a state anybody sits in.
    const named = resource === null ? '' : ` ${resourceLabel(resource.kind)}`;
    parts.push(`${talent.cost.resource}${named}`);
  }
  return parts.length === 0 ? 'free' : parts.join(' · ');
}

/**
 * How far it reaches, and where its hole is.
 *
 * "melee/personal" is ToME's own words for a talent that does not reach past
 * the next tile (Actor.lua:6266-6267 prints exactly that string when
 * `getTalentRange(t) <= 1`). The DEAD ZONE is printed as a band — "3–7" — rather
 * than dropped, because game-design.md § 2 calls the Inspector's `min_range 3`
 * the single most important number she has, and a range printed as a bare 7
 * says she can shoot the thing in her face.
 *
 * EN DASH, matching the damage band the server already formats that way.
 */
function rangeText(talent: LoadoutTalent): string {
  if (talent.shape === TalentShape.Self) return 'self';
  if (talent.range <= 1) return 'melee/personal';
  if (talent.minRange > 0) return `${talent.minRange}–${talent.range}`;
  return `${talent.range}`;
}

/**
 * Turns left, or the word ready.
 *
 * `CooldownsMsg` is complete and absolute — anything in the loadout that is not
 * named there is READY — so a missing key is not missing data and must not read
 * as one. Turns, never seconds: the number steps once per game turn.
 */
function cooldownText(turns: number): string {
  if (turns <= 0) return 'ready';
  const whole = Math.ceil(turns);
  return whole === 1 ? '1 turn' : `${whole} turns`;
}

/**
 * How far into this level, as a fraction — or the word for having run out of
 * levels to be far into.
 *
 * `ProgressMsg.xpToNext` IS 0 AT THE CAP AND THAT IS A SENTINEL, NOT A NUMBER.
 * The server's `sendProgress` documents it: at `MAX_CHARACTER_LEVEL` there is no
 * next level and `xp` keeps accumulating, so any positive denominator would draw
 * a fraction creeping towards a level that never arrives. It is the same shape as
 * `descNext: null` — a fact the renderer must handle rather than divide by.
 *
 * ToME prints this as a PERCENTAGE (CharacterSheet.lua:615,
 * `("Exp  : #00ff00#%2d%%"):format(100 * cur_exp / max_exp)`). We print the two
 * numbers instead, because a percentage of a threshold nobody can see answers
 * "how far along" and not "how much more" — and with roughly 145 kills in the
 * whole ten levels (see progression.ts), "how much more" is the question.
 */
function experienceText(progress: ProgressMsg): string {
  const xp = Math.max(0, Math.floor(progress.xp));
  if (progress.xpToNext <= 0) return `${xp} — top level`;
  return `${xp}/${Math.floor(progress.xpToNext)}`;
}

/**
 * THE SHEET, AS AN ORDERED LIST OF LINES. Pure, and the whole port lives here.
 *
 * The section order is the contract (see the header). Everything below it is
 * either the server's own order, verbatim, or a join of three frames the server
 * deliberately does not do for us.
 */
export function charSheetRows(view: CharSheetView): readonly SheetRow[] {
  const rows: SheetRow[] = [{ kind: SheetRowKind.Section, label: SheetSection.General }];

  const self = view.view;
  if (self === null) {
    // ═══ NEVER A BLANK BOX WHILE THE ROUND TRIP IS OUT ═══
    // `c` opens the sheet and the `inspect` goes out in the same breath, so
    // there is always at least one frame with no answer yet. An empty panel in
    // that window is indistinguishable from a broken one, and the player's next
    // move is to press `c` again — which sends a second `inspect` and spends the
    // socket's rate-limit tokens on a screen that was already working.
    rows.push({ kind: SheetRowKind.Note, text: 'gathering…' });
  } else {
    rows.push({ kind: SheetRowKind.Field, label: 'Name', value: self.name });
    // FROM THE TOP-LEVEL FIELD, NEVER BY SCANNING `rows` FOR A LABEL —
    // protocol.ts says so at `InspectView.className` and gives the reason: the
    // row order is the server's to change and a header that hunted for 'Class'
    // would silently draw a nameless detective. Absent means "no class line",
    // never "unknown", so nothing is drawn when it is missing.
    if (self.className !== undefined) {
      rows.push({ kind: SheetRowKind.Field, label: 'Class', value: self.className });
    }

    // ═══ LEVEL AND EXPERIENCE, BETWEEN CLASS AND LIFE — ToME'S OWN PLACE ═══
    // CharacterSheet.lua:614-615 draws "Level:" then "Exp  :" immediately after
    // the Sex/Race/Class block at :604-606 and immediately before "Life" at
    // :625. That ordering is not decoration: identity, then how far along that
    // identity is, then what is keeping it alive.
    //
    // DRAWN ONLY WHEN THE FRAME HAS ARRIVED. `progress` is unicast in the `hello`
    // block, so a null here is a one-frame window on connect and never a level-0
    // character — and a row reading "Level: 0" in that window would be a wrong
    // number stated confidently, which is worse than a row that is not there yet.
    const progress = view.progress;
    if (progress !== null) {
      rows.push({ kind: SheetRowKind.Field, label: 'Level', value: `${progress.level}` });
      rows.push({
        kind: SheetRowKind.Field,
        label: 'Experience',
        value: experienceText(progress),
      });
      // ═══ ...AND THE POINTS ROW, WHICH IS NOT A STAT ═══
      // ONLY WHILE THERE IS SOMETHING TO SPEND, mirroring ToME's own conditional
      // (uiset/Minimalist.lua:1512-1516 draws the levelup glow, :1587-1589 makes
      // its hotspot clickable, both only under `player.unused_talents > 0 or …`).
      // An unspent point is a call to action rather than a number about the
      // character, so the value NAMES THE KEY that answers it: a player who has
      // never opened the talent panel learns it exists on the sheet they already
      // know how to open, which is ToME's own discovery path
      // (CharacterSheet.lua:99's "[L]evelup" button, ported as the [G] control
      // on this panel's header).
      //
      // THE KEY IS READ OFF THE LIVE KEYMAP AND WAS ONCE THE LITERAL 'g'. This
      // row is the one place a player who has never opened the talent panel
      // learns that it exists, so it is the worst possible place for a stale
      // mnemonic: they would press the letter it names, nothing would happen,
      // and the sheet would have taught them the feature is broken.
      if (progress.unspent > 0) {
        const points = progress.unspent === 1 ? '1 point' : `${progress.unspent} points`;
        rows.push({
          kind: SheetRowKind.Field,
          label: 'Talent points',
          value: `${points} — press ${keyMnemonic('show_talents', view.keymap ?? gameKeymap.current)}`,
        });
      }
    }

    // `ceil`, THE SAME ROUNDING ui/tooltip.ts:143-155, ui/partypanel.ts and
    // ui/turncards.ts use. Since the scheduler moved onto the real damage
    // pipeline `hp` is routinely fractional; rounding differently from the party
    // pane would put 14 on one surface and 15 on another for one body, and a
    // player would reasonably conclude one of them is lying.
    rows.push({
      kind: SheetRowKind.Field,
      label: 'Life',
      value: `${Math.max(0, Math.ceil(self.hp))}/${self.maxHp}`,
    });
  }

  // The pool is its OWN NAME as the label — "Resolve: 40/100" — exactly as
  // ToME's resource loop labels each pool with `res_def.name`
  // (CharacterSheet.lua:650, inside the `resources_def` loop that opens at :628)
  // rather than with the word "resource". Which pool you spend is half the
  // identity of a class.
  if (view.resource !== null) {
    rows.push({
      kind: SheetRowKind.Field,
      label: resourceLabel(view.resource.kind),
      value: `${Math.max(0, Math.round(view.resource.current))}/${view.resource.max}`,
    });
  }

  // ═══ THE SERVER'S ROWS, IN THE SERVER'S ORDER, UNSORTED ═══
  // Fifteen of them today: the six stats, then accuracy/damage/APR/crit, then
  // armour/defence and the three saves. That IS ToME's Attack-then-Defense
  // order; it is composed in src/server/view/inspect.ts and this file must not
  // second-guess it. No row carries `emphasis` on the self branch, so nothing
  // here may depend on it.
  if (self !== null && self.rows.length > 0) {
    rows.push({ kind: SheetRowKind.Section, label: SheetSection.Combat });
    for (const row of self.rows) {
      rows.push({ kind: SheetRowKind.Field, label: row.label, value: row.value });
    }
  }

  if (view.loadout.length > 0) {
    rows.push({ kind: SheetRowKind.Section, label: SheetSection.Talents });
    for (const talent of view.loadout) {
      // IN HOTBAR ORDER. `LoadoutMsg` promises slot 1 is `talents[0]` and asks
      // the client not to sort; a sheet that listed them alphabetically would
      // teach a different order from the one under the player's fingers.
      const turns = view.cooldowns[talent.id] ?? 0;
      rows.push({
        kind: SheetRowKind.Talent,
        name: talent.name,
        icon: talent.icon,
        cost: costText(talent, view.resource),
        range: rangeText(talent),
        cooldown: cooldownText(turns),
        ready: turns <= 0,
      });
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * WHERE THE SHEET GOES, or null when the band it was given cannot hold one.
 *
 * CLAMPED INTO THE BAND, which is the point: `top` is the first free pixel under
 * the top HUD and `bottom` is the first pixel of the bottom bands, so the panel
 * can never come to rest over the hotbar or the prose lines. `height` is the
 * logical viewport and clamps `bottom` in turn — a caller that computed a band
 * against a stale viewport size cannot push the sheet off the bottom of the
 * screen, where its close button would be unreachable and `c` would be the only
 * way out of a panel that looks stuck.
 *
 * CENTRED HORIZONTALLY rather than docked to a side, because both sides are
 * taken: ui/partypanel.ts holds the left and the Case Log holds the right, and a
 * third dock would leave no map at all between them.
 */
export function charSheetRect(options: {
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
  if (band < SHEET_MIN_H + SHEET_MARGIN * 2) return null;
  if (width < SHEET_MIN_W + SHEET_MARGIN * 2) return null;

  const w = Math.min(SHEET_W, width - SHEET_MARGIN * 2);
  const h = Math.min(SHEET_MAX_H, band - SHEET_MARGIN * 2);
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
 * Called by the painter and by `charSheetHitAt`, and by nothing else. It depends
 * on the panel rect alone and never on the rows, which is what lets the hit test
 * answer for a sheet whose contents have not been computed this frame.
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
 * THE `[G]` CONTROL'S RECT, immediately left of the close and derived from it —
 * the same one-copy rule, and derived rather than re-measured so the two can
 * never overlap because `CLOSE_PX` changed.
 */
function talentsRect(rect: PanelRect): PanelRect {
  const close = closeRect(rect);
  return {
    x: close.x - HEADER_BTN_GAP - TALENTS_BTN_W,
    y: rect.y + Math.floor((HEADER_H - CLOSE_PX) / 2),
    w: TALENTS_BTN_W,
    h: CLOSE_PX,
  };
}

/**
 * What a LOGICAL backbuffer point is over. Two controls, both in the header.
 *
 * THE BODY OF THE SHEET STILL ANSWERS NULL EVERYWHERE, and that is unchanged and
 * load-bearing: main.ts eats those clicks with its `overPanel` swallow, and a
 * sheet that started claiming its own rows would be a sheet that could be
 * misclicked into doing something.
 */
export function charSheetHitAt(
  rect: PanelRect,
  px: number,
  py: number,
): 'close' | 'talents' | null {
  const inside = (r: PanelRect): boolean =>
    px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
  if (inside(closeRect(rect))) return 'close';
  // The `[G]` control is only offered when there is room for BOTH buttons and
  // the title beside them. On a panel at `SHEET_MIN_W` the header is 168 pixels
  // wide against a 54-pixel title, so this is comfortably true today — but a
  // button drawn on top of the word CHARACTER would be worse than no button, and
  // the painter tests the same expression.
  if (headerHasTalentsButton(rect) && inside(talentsRect(rect))) return 'talents';
  return null;
}

/**
 * Is there room for the `[G]` control beside the close and the title?
 *
 * ONE expression, read by the painter and by the hit test, for the reason
 * ui/partypanel.ts:93-99 records. `SHEET_TITLE` is nine characters at the
 * CHAR_W estimate; the comparison is against a BOX size, and the title string
 * itself is still clamped by `fitText` at paint time.
 */
function headerHasTalentsButton(rect: PanelRect): boolean {
  const titleW = SHEET_TITLE.length * CHAR_W;
  return rect.w - PANEL_PAD * 2 - CLOSE_PX - HEADER_BTN_GAP - TALENTS_BTN_W >= titleW;
}

/** How many vertical pixels one row wants. */
function rowHeight(row: SheetRow): number {
  switch (row.kind) {
    case SheetRowKind.Section:
      return SECTION_H;
    case SheetRowKind.Talent:
      return TALENT_H;
    case SheetRowKind.Field:
    case SheetRowKind.Note:
      return ROW_H;
  }
}

/**
 * WHICH SECTION GOES FIRST WHEN THERE IS NOT ROOM FOR ALL OF THEM.
 *
 * COMBAT before TALENTS, and GENERAL never. The order is an argument about what
 * a player loses: the fifteen combat rows are a reference table read once a
 * session, the four talents are what they are about to press, and the identity
 * block is the only thing on the screen that says whose sheet this is. Dropping
 * a whole section rather than trimming its tail is deliberate — a stat list cut
 * off after nine rows looks complete and is not.
 */
const DROP_ORDER: readonly SheetSection[] = [SheetSection.Combat, SheetSection.Talents];

/** One row, placed. */
type PlacedRow = {
  readonly row: SheetRow;
  readonly rect: PanelRect;
};

type SheetGeometry = {
  readonly close: PanelRect;
  /** Rows in reading order: down column one, then down column two. */
  readonly placed: readonly PlacedRow[];
  /** How many columns the width bought. Carried so the painter draws the rule. */
  readonly columns: number;
  readonly colW: number;
};

/** Drop a whole section and everything under it, up to the next section. */
function withoutSection(rows: readonly SheetRow[], section: SheetSection): readonly SheetRow[] {
  const out: SheetRow[] = [];
  let skipping = false;
  for (const row of rows) {
    if (row.kind === SheetRowKind.Section) skipping = row.label === section;
    if (!skipping) out.push(row);
  }
  return out;
}

/** Fit `rows` into the columns, or return null when they do not all land. */
function place(
  rows: readonly SheetRow[],
  x: number,
  y: number,
  bottom: number,
  colW: number,
  columns: number,
): readonly PlacedRow[] | null {
  const placed: PlacedRow[] = [];
  let column = 0;
  let cursor = y;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row === undefined) continue;
    const h = rowHeight(row);

    // ═══ A HEADING NEVER SITS ALONE AT THE FOOT OF A COLUMN ═══
    // "TALENTS" at the bottom of column one with all four talents at the top of
    // column two is not a small ugliness: the heading labels the wrong thing.
    // The reader's eye takes the rows UNDER a heading as belonging to it, so an
    // orphan says the column ended and the next block is unlabelled. So a
    // section carries the first row after it, and breaks the column early when
    // the two do not fit together.
    const next = rows[i + 1];
    const need = row.kind === SheetRowKind.Section && next !== undefined ? h + rowHeight(next) : h;

    // The orphan rule is a PREFERENCE and the overflow rule is a fact, so they
    // are tested separately: breaking early is only allowed when there is
    // another column to break into. Otherwise a heading two pixels short of its
    // first row would fail the whole arrangement and cost the reader an entire
    // SECTION — trading a cosmetic flaw for a missing block of the sheet.
    const overflows = cursor + h > bottom;
    const orphaned = cursor + need > bottom && column + 1 < columns;
    if (overflows || orphaned) {
      column += 1;
      cursor = y;
      if (column >= columns) return null;
    }
    placed.push({
      row,
      rect: { x: x + column * (colW + COL_GAP), y: cursor, w: colW, h },
    });
    cursor += h;
  }
  return placed;
}

/**
 * EVERYTHING INSIDE THE PANEL, IN ONE PASS. The painter's only source of truth
 * about where a row lands, and the owner of the drop policy.
 *
 * Tries the whole sheet first, then the sheet minus each section in DROP_ORDER,
 * and stops at the first arrangement that fits. Every drop replaces the section
 * with a NOTE saying what went, because ui/caselog.ts:467-478's rule is that a
 * surface which has quietly stopped showing everything must say so in words and
 * never in a shade.
 */
function sheetGeometry(rect: PanelRect, rows: readonly SheetRow[]): SheetGeometry {
  const close = closeRect(rect);
  const x = rect.x + INSET;
  const innerW = Math.max(0, rect.w - INSET * 2);
  const top = rect.y + HEADER_H + INSET;
  const bottom = rect.y + rect.h - INSET;

  const columns = innerW >= TWO_COL_MIN_W ? 2 : 1;
  const colW = columns === 2 ? Math.floor((innerW - COL_GAP) / 2) : innerW;

  let candidate = rows;
  for (let attempt = 0; attempt <= DROP_ORDER.length; attempt += 1) {
    const placed = place(candidate, x, top, bottom, colW, columns);
    if (placed !== null) return { close, placed, columns, colW };
    const dropping = DROP_ORDER[attempt];
    if (dropping === undefined) break;
    candidate = [
      ...withoutSection(candidate, dropping),
      { kind: SheetRowKind.Note, text: `${dropping.toLowerCase()} hidden — panel too small` },
    ];
  }

  // Even the identity block does not fit. Place what does and stop: `place`
  // returning null is not a licence to draw over the hotbar.
  const placed: PlacedRow[] = [];
  let cursor = top;
  for (const row of candidate) {
    const h = rowHeight(row);
    if (cursor + h > bottom) break;
    placed.push({ row, rect: { x, y: cursor, w: colW, h } });
    cursor += h;
  }
  return { close, placed, columns, colW };
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

/**
 * A talent's icon, blitted 1:1 and CENTRE-CROPPED into an 18px box.
 *
 * NEVER SCALED — nearest-neighbour downscaling of a 64x64 ability icon is
 * exactly the resampling render/canvas.ts's backbuffer exists to prevent, and a
 * smoothed one would be the only blurred thing on the screen. Cropped from the
 * centre rather than the bottom, unlike ui/partypanel.ts's token: a body is
 * identified by its feet, a symbol by its middle.
 *
 * THE FALLBACK IS A LETTER, NOT THE MISSING-ASSET BOX. Today it is the ONLY
 * path: every talent icon is an `icon_active_*` key and that prefix is not in
 * main.ts's `NEEDED_ASSET_PREFIXES`, so nothing resolves — four identical violet
 * error squares would make the block unreadable while the art pipeline catches
 * up, for exactly the reason ui/hotbar.ts:193-201 gives for its own initials.
 */
function drawTalentIcon(
  ctx: CanvasRenderingContext2D,
  sprites: SpriteSource,
  row: Extract<SheetRow, { kind: typeof SheetRowKind.Talent }>,
  box: PanelRect,
): void {
  const sprite = sprites.sprite(row.icon);
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
    return;
  }

  ctx.fillStyle = PALETTE.VOID;
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.fillStyle = PALETTE.SLATE;
  ctx.fillRect(box.x, box.y, box.w, 1);
  ctx.fillRect(box.x, box.y + box.h - 1, box.w, 1);
  ctx.fillRect(box.x, box.y, 1, box.h);
  ctx.fillRect(box.x + box.w - 1, box.y, 1, box.h);
  ctx.font = FONT_ICON_FALLBACK;
  ctx.textAlign = 'center';
  ctx.fillStyle = PALETTE.SILVER;
  ctx.fillText((row.name.charAt(0) || '?').toUpperCase(), box.x + box.w / 2, box.y + box.h / 2);
  ctx.textAlign = 'left';
}

/** One placed row. Every fill sets its own font immediately before it. */
function drawRow(ctx: CanvasRenderingContext2D, sprites: SpriteSource, placed: PlacedRow): void {
  const { row, rect } = placed;
  const right = rect.x + rect.w;

  switch (row.kind) {
    case SheetRowKind.Section: {
      ctx.font = FONT_SECTION;
      ctx.fillStyle = PALETTE.GOLD;
      ctx.fillText(fitText(ctx, row.label, rect.w), rect.x, rect.y + SECTION_H - 6);
      // A rule under the heading, so the sections read as blocks in a column
      // that has no other structure.
      ctx.fillStyle = PALETTE.SLATE;
      ctx.fillRect(rect.x, rect.y + SECTION_H - 1, rect.w, 1);
      return;
    }

    case SheetRowKind.Note: {
      ctx.font = FONT_META;
      ctx.fillStyle = PALETTE.GREY_HI;
      ctx.fillText(fitText(ctx, row.text, rect.w), rect.x, rect.y + ROW_H / 2);
      return;
    }

    case SheetRowKind.Field: {
      // THE VALUE FIRST, right-aligned, and the label shortened against what it
      // actually took. The other way round is how a long label eats the number
      // it exists to introduce.
      ctx.font = FONT_VALUE;
      ctx.textAlign = 'right';
      ctx.fillStyle = PALETTE.PARCHMENT;
      const value = fitText(ctx, row.value, rect.w);
      ctx.fillText(value, right, rect.y + ROW_H / 2);
      const valueW = Math.ceil(ctx.measureText(value).width);
      ctx.textAlign = 'left';

      ctx.font = FONT_LABEL;
      ctx.fillStyle = PALETTE.BONE;
      ctx.fillText(
        fitText(ctx, row.label, Math.max(0, rect.w - valueW - CHAR_W)),
        rect.x,
        rect.y + ROW_H / 2,
      );
      return;
    }

    case SheetRowKind.Talent: {
      const box: PanelRect = {
        x: rect.x,
        y: rect.y + Math.floor((TALENT_H - TALENT_ICON) / 2),
        w: TALENT_ICON,
        h: TALENT_ICON,
      };
      drawTalentIcon(ctx, sprites, row, box);

      const textX = rect.x + TALENT_ICON + 4;
      const textW = Math.max(0, right - textX);

      // READY IS A WORD AS WELL AS A COLOUR, and the word is on the second line
      // where the cooldown always is — so a talent that is available never has
      // to be inferred from a brighter name.
      ctx.font = FONT_VALUE;
      ctx.fillStyle = row.ready ? PALETTE.PARCHMENT : PALETTE.GREY_HI;
      ctx.fillText(fitText(ctx, row.name, textW), textX, rect.y + 7);

      ctx.font = FONT_META;
      ctx.fillStyle = row.ready ? PALETTE.BONE : PALETTE.ORANGE;
      // ToME's tooltip order, minus the mode it has and we do not:
      // cost (Actor.lua:6231-6259), range (:6266-6267), cooldown (:6270).
      const meta = `${row.cost} · ${row.range} · ${row.cooldown}`;
      ctx.fillText(fitText(ctx, meta, textW), textX, rect.y + 17);
      return;
    }
  }
}

export type CharSheetDrawOptions = {
  readonly ctx: CanvasRenderingContext2D;
  readonly sprites: SpriteSource;
  readonly rect: PanelRect;
  /** From `charSheetRows`. Passed in so the caller can hold one copy per frame. */
  readonly rows: readonly SheetRow[];
  /** Highlights the close control, so it reads as pressable. */
  readonly hoveredClose: boolean;
  /** Highlights the `[G]` control. Optional so existing callers still compile. */
  readonly hoveredTalents?: boolean;
  /**
   * True while the talent panel is already open, so the `[G]` control reads as a
   * TOGGLE rather than as a button that appears to do nothing. Optional for the
   * same reason as above.
   */
  readonly talentsOpen?: boolean;
  /**
   * The player's compiled keymap, so the `[G]` control names the LIVE key.
   * Optional and defaulted to `gameKeymap.current` for the reason
   * `CharSheetView.keymap` gives.
   */
  readonly keymap?: Keymap;
};

/**
 * Paint the sheet.
 *
 * `save`/`restore` around everything because it sets `font`, `textAlign`,
 * `textBaseline` and `fillStyle`, none of which the world painter re-sets before
 * every call — a leak surfaces three milestones later as a mysteriously
 * right-aligned label somewhere else entirely. CLIPPED to its own rect for the
 * reason the card strip and the party pane are: a long class name must never
 * bleed onto the map.
 */
export function drawCharSheet(options: CharSheetDrawOptions): void {
  const { ctx, sprites, rect, rows, hoveredClose } = options;
  const hoveredTalents = options.hoveredTalents ?? false;
  const talentsOpen = options.talentsOpen ?? false;
  if (rect.w <= 0 || rect.h <= 0) return;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  drawPanel(ctx, sprites, PanelSkin.CaseFile, rect);
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();

  drawHeader(ctx, sprites, SHEET_TITLE, rect, FONT_SECTION);

  const geometry = sheetGeometry(rect, rows);

  // The divider between the columns. A line rather than nothing, because two
  // columns of label/value pairs with no rule between them read as four columns.
  if (geometry.columns === 2 && geometry.placed.length > 0) {
    ctx.fillStyle = PALETTE.SLATE;
    ctx.fillRect(
      rect.x + INSET + geometry.colW + Math.floor(COL_GAP / 2),
      rect.y + HEADER_H + INSET,
      1,
      Math.max(0, rect.h - HEADER_H - INSET * 2),
    );
  }

  for (const placed of geometry.placed) drawRow(ctx, sprites, placed);

  // ═══ THE `[G]` CONTROL — ToME'S OWN ROUTE TO THE LEVELUP SCREEN ═══
  // dialogs/CharacterSheet.lua:99 puts a "[L]evelup" button on the sheet, and
  // that button is the DISCOVERABLE path: a player who has learned one key
  // (`c`) is shown the other one rather than being expected to find it. The key
  // is the fast path and this is the taught one. Drawn only when the header can
  // hold it without landing on the title — see `headerHasTalentsButton`.
  if (headerHasTalentsButton(rect)) {
    const keymap = options.keymap ?? gameKeymap.current;
    drawButton(ctx, talentsRect(rect), `[${keyMnemonic('show_talents', keymap)}]`, {
      ink: talentsOpen || hoveredTalents ? PALETTE.GOLD : PALETTE.GREY_HI,
    });
  }

  // The close control. `c` closes it too and always will — this is the mouse's
  // way out, for the same reason the erased plate is also a button.
  drawButton(ctx, geometry.close, '×', {
    ink: hoveredClose ? PALETTE.GOLD : PALETTE.GREY_HI,
  });

  ctx.restore();
}
