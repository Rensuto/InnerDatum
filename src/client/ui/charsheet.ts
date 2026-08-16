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
 * Reduced to what this game has, that is: name -> class -> Life -> resource ->
 * the server's own stat/attack/defense rows -> talents. Everything ToME puts
 * there that we do not have — level, xp, gold, equipment, inventory, inscriptions
 * — is ABSENT rather than shown as an empty row, because a row reading "Gold: 0"
 * on a screen with no economy is a promise of a system that does not exist.
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
import {
  drawButton,
  drawHeader,
  drawPanel,
  fitText,
  HEADER_H,
  PANEL_PAD,
  PanelSkin,
} from './panel.ts';
import type { InspectView, LoadoutTalent, ResourceView } from '../../shared/protocol.ts';
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
/** A sheet shorter than a header plus the identity block is not worth drawing. */
const SHEET_MIN_H = HEADER_H + INSET * 2 + SECTION_H + ROW_H * 3;
/** Air between the panel and the edges of the band it is clamped into. */
const SHEET_MARGIN = 6;

/** The close control, top-right of the header strip. Square, so it is a target. */
const CLOSE_PX = 13;

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

/** What a LOGICAL backbuffer point is over. Only the close button is clickable. */
export function charSheetHitAt(rect: PanelRect, px: number, py: number): 'close' | null {
  const close = closeRect(rect);
  const on = px >= close.x && px < close.x + close.w && py >= close.y && py < close.y + close.h;
  return on ? 'close' : null;
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

  // The close control. `c` closes it too and always will — this is the mouse's
  // way out, for the same reason the erased plate is also a button.
  drawButton(ctx, geometry.close, '×', {
    ink: hoveredClose ? PALETTE.GOLD : PALETTE.GREY_HI,
  });

  ctx.restore();
}
