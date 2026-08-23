/// <reference lib="dom" />

import { describe, expect, it } from 'vitest';

import {
  charSheetHitAt,
  charSheetRect,
  charSheetTipAt,
  charSheetRows,
  drawCharSheet,
  SHEET_MIN_H,
  SheetRowKind,
  SheetSection,
  SheetTab,
  SHEET_TABS,
  nextSheetTab,
} from '../../src/client/ui/charsheet.ts';
import { HEADER_H } from '../../src/client/ui/panel.ts';
import { ACTIONS, compileKeymap, DEFAULT_KEYMAP, labelFor } from '../../src/client/input/keymap.ts';
import { TALENTS_PER_CLASS_MAX } from '../../src/shared/progression.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import {
  InspectGroup,
  ItemTier,
  ResourceKind,
  SLOT_ORDER,
  TalentShape,
} from '../../src/shared/protocol.ts';
import { TALENT_MAX_LEVEL } from '../../src/shared/progression.ts';
import type { CharSheetView, SheetRow } from '../../src/client/ui/charsheet.ts';
import type {
  InspectView,
  LoadoutTalent,
  ProgressMsg,
  ResourceView,
} from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CHARACTER SHEET, READ THE WAY A PLAYER READS IT. NO PIXELS ARE ASSERTED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * vitest.config.ts is explicit that there is deliberately no jsdom and no canvas
 * test here, and nothing below paints anything. What is tested is the layer
 * between four frames and the paint:
 *
 *   THE SECTION ORDER  identity -> Life -> resource -> the server's combat rows
 *                      -> talents. THIS IS THE PORT. It is ToME's
 *                      General -> Attack -> Defense -> Talents spine
 *                      (CharacterSheet.lua:605-625, :935-941, :1303-1321),
 *                      reduced to what this game has, and it is the single most
 *                      valuable assertion in this file: everything else about
 *                      the sheet is layout, and layout can be fixed by looking
 *                      at it. A silently reordered sheet cannot.
 *   THE JOIN           the talent rows are composed from `loadout` + `cooldowns`
 *                      + `resource`, none of which is in `inspected`.
 *   THE GATHERING ROW  a null `InspectView` must never produce an empty list —
 *                      an empty panel is indistinguishable from a broken one.
 *   THE HIT TEST       the painter and the pointer read ONE copy of the close
 *                      button's arithmetic.
 *
 * The hit tests SCAN a strip of points rather than asserting coordinates, for
 * the reason test/client/partypanel.test.ts:56-61 gives: an assertion that the
 * close button is at x=300 would pass while it was drawn at x=298, because it
 * would be testing the test's own copy of the arithmetic. What is asserted is
 * what a player experiences — the control is in the header, at the right-hand
 * end, and nothing else on the panel answers a click.
 *
 * THE `reference lib="dom"` ON LINE 1 IS REQUIRED AND HAS A COST, documented in
 * full at test/client/turncards.test.ts:51-60: tests compile under
 * tsconfig.server.json, whose `lib` is ES2024 with no DOM, and ui/charsheet.ts
 * is typed against `CanvasRenderingContext2D`.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The fifteen self rows, in WIRE ORDER — the order src/server/view/inspect.ts
 * emits them for a viewer inspecting themselves. Values are pre-formatted
 * strings: the damage band carries an EN DASH (U+2013) and the crit a percent
 * sign, and no self row carries `emphasis`, so nothing here may depend on it.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FIFTEEN ROWS, GROUPED THE WAY `view/inspect.ts` GROUPS THEM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `group` is not decoration on this fixture — it is what the sheet SPLITS ON.
 * Without it every row falls to the Attack tab (`charSheetRows`' documented
 * fallback for an untagged row) and the Defence tab is empty, which is exactly
 * what this fixture produced before the field was added here.
 *
 * KEPT IN STEP WITH `view/inspect.ts` BY HAND, which is the weakness of any
 * fixture: these nineteen are what that file pushes today, and a row added there
 * and not here means the client's tabs are tested against a sheet nobody is
 * sent. The server's own `inspect.test.ts` pins the real list.
 *
 * The three blocks and their boundaries are the server's, verbatim:
 * `CharacterSheet.lua:815-820` (the six primaries), `:935-1120` (attack) and
 * `:1304-1321` (armour, defence, the three saves).
 */
const SELF_ROWS = [
  { label: 'Strength', value: '14', group: InspectGroup.General },
  { label: 'Dexterity', value: '11', group: InspectGroup.General },
  { label: 'Constitution', value: '13', group: InspectGroup.General },
  { label: 'Magic', value: '10', group: InspectGroup.General },
  { label: 'Willpower', value: '12', group: InspectGroup.General },
  { label: 'Cunning', value: '10', group: InspectGroup.General },
  { label: 'Accuracy', value: '19', group: InspectGroup.Attack },
  { label: 'Damage', value: '12–13', group: InspectGroup.Attack },
  { label: 'APR', value: '2', group: InspectGroup.Attack },
  { label: 'Crit. chance', value: '3%', group: InspectGroup.Attack },
  // The three powers — CharacterSheet.lua:1161, :1167-1168, :1179-1181.
  { label: 'Phys. power', value: '21', group: InspectGroup.Attack },
  { label: 'Spellpower', value: '10', group: InspectGroup.Attack },
  { label: 'Mindpower', value: '13', group: InspectGroup.Attack },
  { label: 'Armour', value: '4', group: InspectGroup.Defence },
  { label: 'Defence', value: '8', group: InspectGroup.Defence },
  // CharacterSheet.lua:1302 — the number `BREACHED` halves.
  { label: 'Armour hardiness', value: '30%', group: InspectGroup.Defence },
  { label: 'Physical save', value: '9', group: InspectGroup.Defence },
  { label: 'Spell save', value: '5', group: InspectGroup.Defence },
  { label: 'Mental save', value: '6', group: InspectGroup.Defence },
] as const;

/**
 * WHICH GROUP EACH STAT TAB ASKS FOR. Spelled here rather than imported, because
 * the mapping inside charsheet.ts is the thing under test — a test that imported
 * it would agree with the sheet by construction and prove nothing.
 */
const TAB_GROUP: Partial<Record<SheetTab, InspectGroup>> = {
  [SheetTab.General]: InspectGroup.General,
  [SheetTab.Attack]: InspectGroup.Attack,
  [SheetTab.Defence]: InspectGroup.Defence,
};

function selfView(over: Partial<InspectView> = {}): InspectView {
  return {
    id: 'actor_a',
    name: 'Dalt',
    className: 'The Watchman',
    kind: 'detective',
    hp: 41.000000000000014,
    maxHp: 58,
    effects: [],
    rows: SELF_ROWS.map((row) => ({ label: row.label, value: row.value, group: row.group })),
    ...over,
  };
}

function pool(over: Partial<ResourceView> = {}): ResourceView {
  return { kind: ResourceKind.Resolve, current: 40, max: 100, discrete: false, ...over };
}

/**
 * The v9 `progress` frame. Level 4, part-way through, NOTHING IN HAND by
 * default — an unspent point is the exceptional state and every test that cares
 * about it says so, so the common fixture must not quietly enable the one
 * conditional row on this sheet.
 */
function progressFrame(over: Partial<ProgressMsg> = {}): ProgressMsg {
  return {
    v: PROTOCOL_VERSION,
    t: 'progress',
    level: 4,
    xp: 61,
    xpToNext: 174,
    unspent: 0,
    // The second purse. Zero by default for the same reason the first is: an
    // unspent point is the exceptional state, and the sheet has a conditional row
    // for each that a common fixture must not quietly switch on.
    unspentGenerics: 0,
    ...over,
  };
}

function talent(over: Partial<LoadoutTalent> & { id: string; name: string }): LoadoutTalent {
  return {
    icon: 'icon_active_ward_rush',
    cost: { ap: 5, mp: 0, resource: 0 },
    cooldownTurns: 3,
    range: 1,
    minRange: 0,
    shape: TalentShape.Single,
    radius: 0,
    // The four v9 progression fields. Defaulted to a birth-rank talent, which is
    // what every one of this file's cases is about — the sheet draws a hotbar,
    // not a levelup panel, so a rank is background rather than subject.
    level: 1,
    maxLevel: TALENT_MAX_LEVEL,
    desc: 'A talent.',
    descNext: 'A slightly better talent.',
    ...over,
  };
}

const LOADOUT: readonly LoadoutTalent[] = [
  talent({ id: 'talent:ward_rush', name: 'Ward Rush' }),
  talent({
    id: 'talent:iron_curtain',
    name: 'Iron Curtain',
    shape: TalentShape.Self,
    range: 0,
    cost: { ap: 3, mp: 0, resource: 20 },
  }),
  talent({
    id: 'talent:long_shot',
    name: 'Long Shot',
    range: 7,
    minRange: 3,
    cost: { ap: 4, mp: 0, resource: 10 },
  }),
  talent({
    id: 'talent:fog_step',
    name: 'Fog Step',
    shape: TalentShape.Tile,
    range: 4,
    cost: { ap: 0, mp: 0, resource: 0 },
  }),
];

function sheet(over: Partial<CharSheetView> = {}): CharSheetView {
  return {
    view: selfView(),
    resource: pool(),
    loadout: LOADOUT,
    cooldowns: {},
    progress: progressFrame(),
    ...over,
  };
}

/**
 * Section labels, in the order they appear. The port, extracted.
 *
 * `flatMap` rather than `filter().map()`: a boolean predicate does not narrow a
 * discriminated union in TypeScript, so the filtered array would still be typed
 * as every row kind and `.label` would not exist on it.
 */
function sections(rows: readonly SheetRow[]): readonly string[] {
  return rows.flatMap((row) => (row.kind === SheetRowKind.Section ? [row.label] : []));
}

/** Field labels, in the order they appear. */
function fieldLabels(rows: readonly SheetRow[]): readonly string[] {
  return rows.flatMap((row) => (row.kind === SheetRowKind.Field ? [row.label] : []));
}

// ---------------------------------------------------------------------------
// THE SECTION ORDER — the ported contract
// ---------------------------------------------------------------------------

describe('charSheetRows follows ToME’s sheet, reduced', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ONE SECTION PER TAB — which is what the sheet growing tabs actually means.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * This asserted `[GENERAL, COMBAT, TALENTS]` off one call, and its comment
   * explained that ToME's Attack (`CharacterSheet.lua:935-941`) and Defense
   * (`:1303-1321`) tabs *"collapse into one COMBAT section here because the
   * server sends them as one ordered list"*. The server sends `InspectRow.group`
   * now and nothing collapses.
   *
   * BUILT FROM `SHEET_TABS`, NOT SPELLED OUT. The header of charsheet.ts calls
   * the section order the contract and says a test that spelled the sections
   * itself *"would keep passing while the sheet drew them in the wrong order"*.
   * The same trap has a second door once there are tabs: a test naming four
   * sections in one line would keep passing if a tab showed the WRONG one, as
   * long as all four appeared somewhere. Asking each tab separately is what
   * closes it.
   */
  it('gives every tab exactly one section, and no tab another tab’s', () => {
    const seen = SHEET_TABS.map((tab) => sections(charSheetRows(sheet(), tab)));
    for (const [i, only] of seen.entries()) {
      expect(
        only,
        `tab ${String(SHEET_TABS[i])} emitted ${String(only.length)} sections`,
      ).toHaveLength(1);
    }
    // AND ALL FOUR ARE DISTINCT, so two tabs cannot quietly show one page.
    const flat = seen.flat();
    expect(new Set(flat).size, 'two tabs share a section').toBe(SHEET_TABS.length);
  });

  /** The four ToME tabs, in ToME's order — CharacterSheet.lua:54-57. */
  it('opens on General and cycles the way upstream does', () => {
    expect(SHEET_TABS[0]).toBe(SheetTab.General);
    let tab: SheetTab = SheetTab.General;
    const walked: SheetTab[] = [tab];
    for (let i = 1; i < SHEET_TABS.length; i += 1) {
      tab = nextSheetTab(tab);
      walked.push(tab);
    }
    expect(walked).toEqual([...SHEET_TABS]);
    // AND IT WRAPS, in both directions. Stepping back from the first tab must
    // reach the last rather than indexing off the front of the list.
    expect(nextSheetTab(tab)).toBe(SheetTab.General);
    expect(nextSheetTab(SheetTab.General, true)).toBe(SHEET_TABS[SHEET_TABS.length - 1]);
  });

  it('opens with identity, then Life, then the pool — never the numbers first', () => {
    const rows = charSheetRows(sheet(), SheetTab.General);
    // ToME prints Sex/Race/Class (CharacterSheet.lua:604-606), then Level and
    // Exp (:614-615), then "Life" (:625), then the `resources_def` loop. Ours has
    // no sex and no race, so: name, class, level, experience, life, pool.
    expect(fieldLabels(rows).slice(0, 6)).toEqual([
      'Name',
      'Class',
      'Level',
      'Experience',
      'Life',
      'Resolve',
    ]);
  });

  it('draws the class from the top-level field and never from a row labelled Class', () => {
    // protocol.ts makes `className` a field precisely so the header cannot go
    // hunting through `rows`. Absent means "no class line", never "unknown".
    const rows = charSheetRows(
      sheet({ view: selfView({ className: undefined }) }),
      SheetTab.General,
    );
    expect(fieldLabels(rows)).not.toContain('Class');
    expect(fieldLabels(rows).slice(0, 2)).toEqual(['Name', 'Level']);
  });

  /**
   * THE SERVER'S ORDER SURVIVES THE SPLIT — checked per tab, and the union of
   * the tabs is still the server's fifteen with nothing lost between pages.
   *
   * This read the fifteen off one call, because there was one page. Splitting
   * them created a second way to be wrong that a single-list check cannot see:
   * a row could keep its position WITHIN its group and land on the wrong tab.
   * So both halves are asserted — order inside each page, and no row missing
   * from all of them.
   */
  it('keeps the server’s rows in the server’s order on every tab', () => {
    const stats = [SheetTab.General, SheetTab.Attack, SheetTab.Defence];
    const gathered: string[] = [];
    for (const tab of stats) {
      const labels = fieldLabels(charSheetRows(sheet(), tab));
      const wanted = SELF_ROWS.filter((row) => row.group === TAB_GROUP[tab]).map((r) => r.label);
      const mine = labels.filter((label) => (wanted as readonly string[]).includes(label));
      expect(mine, `${String(tab)} reordered the server's rows`).toEqual(wanted);
      gathered.push(...mine);
    }
    // NOTHING FELL BETWEEN THE PAGES. A row tagged with a group no tab asks for
    // would vanish from the sheet entirely, and no per-tab check would notice.
    expect(gathered).toEqual(SELF_ROWS.map((row) => row.label));
    // Belt and braces: an alphabetising client would put APR first.
    expect(gathered[0]).toBe('Strength');
  });

  it('rounds hp UP, the same way every other surface in the client does', () => {
    // ui/tooltip.ts:143-155: the damage pipeline produces fractional hp, and one
    // body reading 41 in the party pane and 42 here would make a player
    // reasonably conclude one of them is lying.
    const rows = charSheetRows(sheet(), SheetTab.General);
    const life = rows.find((row) => row.kind === SheetRowKind.Field && row.label === 'Life');
    expect(life).toEqual({ kind: SheetRowKind.Field, label: 'Life', value: '42/58' });
  });

  it('omits the pool entirely rather than drawing an empty row for it', () => {
    const rows = charSheetRows(sheet({ resource: null }), SheetTab.General);
    // THE GENERAL PAGE ONLY — identity, then the six primaries. Attack and
    // Defence are their own tabs and their rows are asserted there.
    expect(fieldLabels(rows)).toEqual([
      'Name',
      'Class',
      'Level',
      'Experience',
      'Life',
      ...SELF_ROWS.filter((r) => r.group === InspectGroup.General).map((r) => r.label),
    ]);
  });

  it('names the pool by its own name, as ToME labels each resource', () => {
    const rows = charSheetRows(
      sheet({
        resource: pool({ kind: ResourceKind.Reagents, current: 3, max: 8, discrete: true }),
      }),
      SheetTab.General,
    );
    expect(rows).toContainEqual({ kind: SheetRowKind.Field, label: 'Reagents', value: '3/8' });
  });

  it('FLOORS a fractional pool, so this row and the pip strip cannot disagree', () => {
    // ═══════════════════════════════════════════════════════════════════════
    // THE ROUNDING HAZARD THE CODEBASE NAMED, ON THE POOLS IT WAS LEFT OPEN FOR.
    // ═══════════════════════════════════════════════════════════════════════
    // Resolve and Focus only ever moved in whole numbers until the pools started
    // trickling; `RESOLVE_PER_TURN` 0.6 and `FOCUS_PER_TURN` 0.4 make them
    // fractional on almost every turn. This row used `Math.round` while
    // ui/resource.ts's pip strip prints `Math.floor`, the `no_resource` refusal
    // prints `Math.floor`, and both the client's `affordable` and the server's
    // `hasResource` compare the RAW value.
    //
    // 24.6 is four blows taken (4 x 6) plus one turn of trickle. Rounded it read
    // `25/100` — one more than the strip beside it, and a promise that Iron
    // Curtain (25) was payable when the server would refuse it.
    const rows = charSheetRows(
      sheet({ resource: pool({ current: 24.6, max: 100 }) }),
      SheetTab.General,
    );
    expect(rows).toContainEqual({
      kind: SheetRowKind.Field,
      label: 'Resolve',
      value: '24/100',
    });
    expect(Math.floor(24.6)).toBe(24);
    // Just under a whole pip floors down too, rather than presenting a pool the
    // player does not have.
    expect(
      charSheetRows(sheet({ resource: pool({ current: 0.9 }) }), SheetTab.General),
    ).toContainEqual({
      kind: SheetRowKind.Field,
      label: 'Resolve',
      value: '0/100',
    });
    // ...and it never goes negative, which is the `Math.max(0, …)` beside it.
    expect(
      charSheetRows(sheet({ resource: pool({ current: -3.2 }) }), SheetTab.General),
    ).toContainEqual({
      kind: SheetRowKind.Field,
      label: 'Resolve',
      value: '0/100',
    });
  });
});

// ---------------------------------------------------------------------------
// v9 — LEVEL, EXPERIENCE, AND THE ROW THAT IS A CALL TO ACTION
// ---------------------------------------------------------------------------

describe('the progression rows', () => {
  function labelled(rows: readonly SheetRow[], label: string) {
    return rows.flatMap((row) =>
      row.kind === SheetRowKind.Field && row.label === label ? [row] : [],
    );
  }

  it('sits Level and Experience between Class and Life, where ToME puts them', () => {
    // CharacterSheet.lua:606 draws the Class line, :614-615 Level then Exp, :625
    // Life. That order is the port and it is what this assertion pins: identity,
    // then how far along that identity is, then what keeps it alive.
    const labels = fieldLabels(charSheetRows(sheet(), SheetTab.General));
    expect(labels.indexOf('Level')).toBeGreaterThan(labels.indexOf('Class'));
    expect(labels.indexOf('Experience')).toBe(labels.indexOf('Level') + 1);
    expect(labels.indexOf('Life')).toBe(labels.indexOf('Experience') + 1);
  });

  it('prints the two xp numbers rather than ToME’s percentage', () => {
    expect(labelled(charSheetRows(sheet(), SheetTab.General), 'Experience')[0]?.value).toBe(
      '61/174',
    );
    expect(labelled(charSheetRows(sheet(), SheetTab.General), 'Level')[0]?.value).toBe('4');
  });

  it('says “top level” instead of dividing by the cap’s zero denominator', () => {
    // `sendProgress` sends xpToNext = 0 at MAX_CHARACTER_LEVEL as a SENTINEL:
    // there is no next level and xp keeps accumulating, so any positive
    // denominator would draw a fraction creeping towards a level that never
    // arrives. It is a fact to handle, never a number to divide by.
    const rows = charSheetRows(
      sheet({ progress: progressFrame({ level: 10, xp: 900, xpToNext: 0 }) }),
      SheetTab.General,
    );
    expect(labelled(rows, 'Experience')[0]?.value).toBe('900 — top level');
  });

  it('draws no level line at all before the first progress frame', () => {
    // Null is a one-frame window on connect, not a level-0 character. A row
    // reading "Level: 0" in that window is a wrong number stated confidently.
    const labels = fieldLabels(charSheetRows(sheet({ progress: null }), SheetTab.General));
    expect(labels).not.toContain('Level');
    expect(labels).not.toContain('Experience');
    expect(labels).not.toContain('Talent points');
  });

  it('hides the points row at zero and shows it above zero, naming the key', () => {
    // ToME's own conditional: uiset/Minimalist.lua:1512-1516 draws the levelup
    // glow and :1587-1589 makes its hotspot clickable only under
    // `player.unused_talents > 0 or ...`. A row reading "0 points" on every open
    // is furniture within one session.
    //
    // ═══ THE TALENT PANEL DELIBERATELY DIFFERS, AND THAT IS RECORDED HERE SO
    //     NOBODY "FIXES" THE INCONSISTENCY ═══
    // ui/talents.ts's points row is UNCONDITIONAL and states one of three things
    // at every count (test/client/talents.test.ts pins all three). The line
    // between the two surfaces is what each one IS: this is a STAT PAGE, where a
    // call to action appears when there is something to answer — Minimalist's
    // plate, cited above — while that is the SPEND SCREEN, where upstream keeps
    // its four counters visible at zero and regenerates them after every spend
    // (LevelupDialog.lua:757-784, :1001-1008). Flipping this one too would also
    // move SHEET_MIN_H, which gates whether this panel opens at all.
    expect(fieldLabels(charSheetRows(sheet(), SheetTab.General))).not.toContain('Talent points');

    const rows = charSheetRows(
      sheet({ progress: progressFrame({ unspent: 3 }) }),
      SheetTab.General,
    );
    const points = labelled(rows, 'Talent points')[0];
    expect(points).toBeDefined();
    expect(points?.value).toContain('3 points');
    // IT NAMES THE KEY, AND IT NAMES THE LIVE ONE. This row is the only place a
    // player who has never opened the talent panel learns that it exists — an
    // unspent point is a call to action, and a call to action with no
    // instruction is a stat. The letter used to be written into this file as
    // 'g'; `show_talents` is rebindable now, so a hard-coded mnemonic tells a
    // player to press something that does nothing.
    expect(points?.value).toContain(labelFor('show_talents', DEFAULT_KEYMAP));
  });

  it('follows a rebound talent key rather than repeating the shipped letter', () => {
    // The assertion above would pass forever against a hard-coded 'G'. This is
    // the one that cannot: the same row, the same view, a different keymap.
    const rebound = compileKeymap(ACTIONS, { show_talents: ['key:z'] });
    const rows = charSheetRows(
      sheet({ progress: progressFrame({ unspent: 2 }), keymap: rebound }),
      SheetTab.General,
    );
    expect(labelled(rows, 'Talent points')[0]?.value).toContain('press Z');
  });

  it('says “1 point”, not “1 points”', () => {
    const rows = charSheetRows(
      sheet({ progress: progressFrame({ unspent: 1 }) }),
      SheetTab.General,
    );
    expect(labelled(rows, 'Talent points')[0]?.value).toContain('1 point —');
  });

  it('keeps the points row conditional even though the talent panel’s is not', () => {
    // The assertion above is about ONE fixture. This is the rule, asked directly
    // and left as the record of a decision: the sheet is a stat page and the
    // panel is the spend screen, so the sheet's call to action goes away and the
    // panel's count does not.
    for (const unspent of [0, 1, 5]) {
      const labels = fieldLabels(
        charSheetRows(sheet({ progress: progressFrame({ unspent }) }), SheetTab.General),
      );
      expect(labels.includes('Talent points'), `unspent=${unspent}`).toBe(unspent > 0);
    }
  });

  it('puts the points row under Experience and still above Life', () => {
    const labels = fieldLabels(
      charSheetRows(sheet({ progress: progressFrame({ unspent: 2 }) }), SheetTab.General),
    );
    expect(labels.indexOf('Talent points')).toBe(labels.indexOf('Experience') + 1);
    expect(labels.indexOf('Life')).toBe(labels.indexOf('Talent points') + 1);
  });
});

// ---------------------------------------------------------------------------
// The gathering row
// ---------------------------------------------------------------------------

describe('charSheetRows while the round trip is out', () => {
  it('says “gathering…” and never returns an empty list', () => {
    const rows = charSheetRows(sheet({ view: null }), SheetTab.General);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).toContainEqual({ kind: SheetRowKind.Note, text: 'gathering…' });
  });

  it('still shows the talents and the pool, which come from other frames', () => {
    // The loadout and the resource are unicast on connect and are NOT part of
    // the `inspect` round trip, so hiding them while the answer is in flight
    // would blank three quarters of a sheet that is already fully known.
    // ASKED PER PAGE, because they no longer share one. The point is unchanged
    // and is now sharper: neither page waits on the `inspect` round trip.
    const general = charSheetRows(sheet({ view: null }), SheetTab.General);
    expect(sections(general)).toEqual([SheetSection.General]);
    expect(fieldLabels(general)).toEqual(['Resolve']);

    const talents = charSheetRows(sheet({ view: null }), SheetTab.Talents);
    expect(sections(talents)).toEqual([SheetSection.Talents]);
    expect(talents.flatMap((row) => (row.kind === SheetRowKind.Talent ? [row] : []))).toHaveLength(
      4,
    );
  });

  it('still says something when literally nothing has arrived', () => {
    const rows = charSheetRows(
      {
        view: null,
        resource: null,
        loadout: [],
        cooldowns: {},
        progress: null,
      },
      SheetTab.General,
    );
    expect(rows).toEqual([
      { kind: SheetRowKind.Section, label: SheetSection.General },
      { kind: SheetRowKind.Note, text: 'gathering…' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The talent block — composed client-side from three frames
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE EQUIPMENT PAGE — CharacterSheet.lua:61.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The tab this sheet shipped WITHOUT, on the argument that `CharSheetView`
 * carried no worn items. It carried none because nobody had passed any;
 * `InventoryMsg.equipped` was already on the wire and already in the client.
 */
describe('the equipment rows', () => {
  const coat = {
    itemId: 'item_watchmans_coat',
    name: "Watchman's Coat",
    icon: 'item_watchmans_coat',
    tier: ItemTier.Common,
    desc: 'Heavy wool, official issue.',
    // WHAT IT IS GIVING YOU — `ItemView.compare`. The sheet does not draw these
    // rows (the inventory panel does), so an empty list is the honest fixture.
    compare: [],
  } as const;

  it('lists every slot in the wire’s order, worn or not', () => {
    const rows = charSheetRows(sheet({ equipped: { body: coat } }), SheetTab.Equipment);
    expect(fieldLabels(rows)).toEqual([
      'Head',
      'Body',
      'Legs',
      'Feet',
      'Offhand',
      'Ring',
      'Trinket',
    ]);
    // AND THE ORDER IS `SLOT_ORDER`'s, not this file's opinion of it.
    expect(fieldLabels(rows).map((l) => l.toLowerCase())).toEqual([...SLOT_ORDER]);
  });

  /**
   * AN EMPTY SLOT KEEPS ITS ROW, and the reason is not tidiness. This sheet
   * DROPS a field whose value is empty — that is how the absent resource pool
   * disappears — so an empty string here would delete the row and take the
   * slot's NAME with it, which is the half worth printing. An empty Ring row is
   * the answer to "why is my armour 4".
   */
  it('keeps a row for a slot with nothing in it', () => {
    const rows = charSheetRows(sheet({ equipped: { body: coat } }), SheetTab.Equipment);
    const valueOf = (label: string): string | undefined =>
      rows.flatMap((row) =>
        row.kind === SheetRowKind.Field && row.label === label ? [row.value] : [],
      )[0];
    expect(valueOf('Body')).toBe("Watchman's Coat");
    expect(valueOf('Ring'), 'an empty slot lost its row').toBe('—');
  });

  /**
   * AND "THE FRAME HAS NOT ARRIVED" IS NOT "WEARING NOTHING".
   *
   * `inventory` is unicast on connect, so this panel can be built before it
   * lands. Seven em dashes would be a confident, wrong answer — the same class
   * of lie the `gathering…` note exists to prevent on the General page.
   */
  it('says it is still waiting rather than drawing seven empty slots', () => {
    const rows = charSheetRows(sheet({ equipped: undefined }), SheetTab.Equipment);
    expect(fieldLabels(rows), 'it answered before the frame arrived').toEqual([]);
    expect(rows.some((row) => row.kind === SheetRowKind.Note)).toBe(true);
  });

  /** Wearing nothing IS a state, and it looks different from not knowing. */
  it('draws all seven as empty once the frame says so', () => {
    const rows = charSheetRows(sheet({ equipped: {} }), SheetTab.Equipment);
    expect(fieldLabels(rows)).toHaveLength(SLOT_ORDER.length);
    expect(rows.some((row) => row.kind === SheetRowKind.Note)).toBe(false);
  });
});

describe('the talent rows', () => {
  function talentRows(view: CharSheetView) {
    return charSheetRows(view, SheetTab.Talents).flatMap((row) =>
      row.kind === SheetRowKind.Talent ? [row] : [],
    );
  }

  it('stays in hotbar order, so the sheet teaches the keys under your fingers', () => {
    expect(talentRows(sheet()).map((row) => row.name)).toEqual([
      'Ward Rush',
      'Iron Curtain',
      'Long Shot',
      'Fog Step',
    ]);
  });

  it('carries the wire’s own icon key and never one built from the name', () => {
    expect(talentRows(sheet())[0]?.icon).toBe('icon_active_ward_rush');
  });

  it('reads a missing cooldown entry as READY, because the frame is absolute', () => {
    // `CooldownsMsg` deletes the key at zero, mirroring ToME's
    // `talents_cd[tid] = nil` (ActorTalents.lua:1002-1013). A client that read
    // the absence as "unknown" would hold a button grey forever.
    const rows = talentRows(sheet({ cooldowns: { 'talent:long_shot': 2 } }));
    expect(rows.map((row) => row.cooldown)).toEqual(['ready', 'ready', '2 turns', 'ready']);
    expect(rows.map((row) => row.ready)).toEqual([true, true, false, true]);
  });

  it('says “1 turn”, not “1 turns”', () => {
    expect(talentRows(sheet({ cooldowns: { 'talent:ward_rush': 1 } }))[0]?.cooldown).toBe('1 turn');
  });

  it('prints the dead zone as a band, because a bare 7 says she can shoot her feet', () => {
    // game-design.md § 2 calls the Inspector's min_range the single most
    // important number she has. EN DASH, matching the server's damage band.
    expect(talentRows(sheet())[2]?.range).toBe('3–7');
  });

  it('uses ToME’s own words for a talent that does not reach', () => {
    // Actor.lua:6266-6267 prints "melee/personal" when getTalentRange(t) <= 1.
    expect(talentRows(sheet())[0]?.range).toBe('melee/personal');
    // ...and a `self` shape is not even a range question.
    expect(talentRows(sheet())[1]?.range).toBe('self');
  });

  it('names the pool in the cost, and omits every zero budget', () => {
    // Actor.lua:6236-6243 lists only non-zero costs. Three zeros read as
    // "unknown" at a glance, so a free talent says so in a word.
    expect(talentRows(sheet()).map((row) => row.cost)).toEqual([
      'AP 5',
      'AP 3 · 20 Resolve',
      'AP 4 · 10 Resolve',
      'free',
    ]);
  });

  it('falls back to a bare number when the resource frame has not arrived', () => {
    expect(talentRows(sheet({ resource: null }))[1]?.cost).toBe('AP 3 · 20');
  });
});

// ---------------------------------------------------------------------------
// Layout and hit testing
// ---------------------------------------------------------------------------

describe('charSheetRect', () => {
  it('stays inside the band it was given, so it can never sit under the hotbar', () => {
    const rect = charSheetRect({ width: 640, height: 400, top: 20, bottom: 360 });
    expect(rect).not.toBeNull();
    if (rect === null) throw new Error('unreachable');
    expect(rect.y).toBeGreaterThanOrEqual(20);
    expect(rect.y + rect.h).toBeLessThanOrEqual(360);
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.w).toBeLessThanOrEqual(640);
  });

  it('clamps the band against the viewport, not just against what it was told', () => {
    // A caller holding a stale viewport size must not be able to push the panel
    // off the bottom, where the close button would be unreachable.
    const rect = charSheetRect({ width: 640, height: 240, top: 20, bottom: 900 });
    if (rect === null) throw new Error('unreachable');
    expect(rect.y + rect.h).toBeLessThanOrEqual(240);
  });

  it('gives up rather than drawing a sheet taller than the band', () => {
    expect(charSheetRect({ width: 640, height: 400, top: 20, bottom: 70 })).toBeNull();
    expect(charSheetRect({ width: 120, height: 400, top: 20, bottom: 360 })).toBeNull();
  });

  it('still opens, and still draws every identity row, at exactly SHEET_MIN_H', () => {
    // ═══ THE STALE-CONSTANT TEST ═══
    // `SHEET_MIN_H` is DERIVED — header + inset*2 + one section + five identity
    // rows — and v9 added two of those five. Left at three it would let the panel
    // open into a band that cannot hold what `charSheetRows` now returns; the
    // failure is a sheet that reports a rect and then silently drops its own
    // COMBAT block on an ordinary short window. This finds either mistake by
    // asking for the tightest legal band and checking the panel is both offered
    // and tall enough for the block it promises.
    const rect = charSheetRect({ width: 640, height: 400, top: 0, bottom: SHEET_MIN_H + 12 });
    expect(rect).not.toBeNull();
    if (rect === null) throw new Error('unreachable');
    expect(rect.h).toBeGreaterThanOrEqual(SHEET_MIN_H);

    // ═══ AND THE CONSTANT ITSELF IS PINNED, BECAUSE THE LEVELUP WORK CAME
    //     CLOSE TO MOVING IT ═══
    // HEADER_H 24 + the tab strip (13 + a 4px half-inset) + INSET 8 twice +
    // SECTION_H 18 + ROW_H 12 × five identity rows. The talent-points row is
    // deliberately NOT one of the five: it is conditional on this surface (see
    // the two tests below), and sizing the minimum for a row that is usually
    // absent would refuse to draw a perfectly good sheet on a short viewport.
    // Making that row unconditional — which the TALENT PANEL now does — would
    // move this number, and this number gates whether the panel opens at all.
    //
    // THE STRIP MOVED IT, which is the case that comment was anticipating: the
    // tabs sit between the header and the rows, so a minimum that ignored them
    // would promise five identity rows and draw four.
    expect(SHEET_MIN_H).toBe(HEADER_H + 13 + 4 + 8 * 2 + 18 + 12 * 5);

    // One pixel shorter and it must refuse, so the constant is a real edge
    // rather than a number nothing reads.
    expect(charSheetRect({ width: 640, height: 400, top: 0, bottom: SHEET_MIN_H + 11 })).toBeNull();
  });
});

describe('charSheetHitAt', () => {
  const rect = charSheetRect({ width: 640, height: 400, top: 20, bottom: 360 });
  if (rect === null) throw new Error('unreachable');

  it('answers only in the header strip, at the right-hand end', () => {
    // A SCAN, not a coordinate: every point across the header is tried and the
    // hits are described. An assertion that the button is at x=300 would pass
    // while it was drawn at x=298 (partypanel.test.ts:56-61).
    const hits: number[] = [];
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      if (charSheetHitAt(rect, x, rect.y + Math.floor(HEADER_H / 2)) === 'close') hits.push(x);
    }
    expect(hits.length).toBeGreaterThan(0);
    // Contiguous, and in the right-hand quarter of the panel.
    expect(hits[hits.length - 1] ?? 0).toBe((hits[0] ?? 0) + hits.length - 1);
    expect(hits[0]).toBeGreaterThan(rect.x + Math.floor((rect.w * 3) / 4));
    expect(hits[hits.length - 1]).toBeLessThan(rect.x + rect.w);
  });

  it('is not clickable anywhere in the body, so the sheet swallows nothing else', () => {
    const column = rect.x + rect.w - 10;
    for (let y = rect.y + HEADER_H; y < rect.y + rect.h; y += 1) {
      expect(charSheetHitAt(rect, column, y)).toBeNull();
    }
    // ...and the BODY's top-left, which is one pixel below the header strip. It
    // used to be enough to test `rect.y + 4` here; that point is now the DRAG
    // HANDLE (see below), so the assertion moves down to the first row of the
    // body — which is what the sentence above was always about.
    expect(charSheetHitAt(rect, rect.x + 4, rect.y + HEADER_H)).toBeNull();
  });

  it('offers the header strip as a drag handle, and the controls still win', () => {
    // ═══ PRECEDENCE, NOT GEOMETRY ═══
    // A SCAN across the header. What is asserted is that the two CONTROLS keep
    // every pixel they had — one press that used to press a button and now moves
    // the window is the failure ui/panel.ts:193-223 describes in full — and that
    // what is left of the strip answers `header`.
    const y = rect.y + Math.floor(HEADER_H / 2);
    const kinds: (string | null)[] = [];
    for (let x = rect.x; x < rect.x + rect.w; x += 1) kinds.push(charSheetHitAt(rect, x, y));

    expect(kinds.filter((hit) => hit === 'header').length).toBeGreaterThan(0);
    expect(kinds.filter((hit) => hit === 'close').length).toBeGreaterThan(0);
    expect(kinds.filter((hit) => hit === 'talents').length).toBeGreaterThan(0);
    // The handle is the LEFT part, contiguous, starting at the panel's own edge,
    // and everything left of the first control is grabbable — no dead strip.
    const lastHandle = kinds.lastIndexOf('header');
    expect(kinds.indexOf('header')).toBe(0);
    expect(kinds.slice(0, lastHandle + 1).every((hit) => hit === 'header')).toBe(true);
    // And it stops before the leftmost control — the `[G]` button, not the ×.
    const firstControl = kinds.indexOf('talents');
    expect(lastHandle).toBe(firstControl - 1);
    // THE ONLY UNCLAIMED PIXELS ARE THE DELIBERATE ONES, and they are all to the
    // RIGHT of the first control: `HEADER_BTN_GAP`'s three pixels between the two
    // buttons, so neither swallows the other's click, and `PANEL_PAD`'s five at
    // the very edge. A null to the LEFT of the controls would be a dead patch of
    // handle, which is a header that only sometimes picks the window up.
    expect(kinds.slice(0, firstControl).some((hit) => hit === null)).toBe(false);
    expect(kinds.filter((hit) => hit === null)).toHaveLength(3 + 5);
  });

  it('does not make the body draggable — the handle is the strip and no more', () => {
    // A handle one pixel taller makes the first row of the sheet draggable, so a
    // click meant for a stat row would move the panel instead.
    expect(charSheetHitAt(rect, rect.x + 4, rect.y + HEADER_H - 1)).toBe('header');
    expect(charSheetHitAt(rect, rect.x + 4, rect.y + HEADER_H)).toBeNull();
  });

  it('offers the talent control immediately left of the close, and never over it', () => {
    // ToME's own discoverable route to its levelup screen is a button on the
    // character sheet (CharacterSheet.lua:99's "[L]evelup"). A SCAN across the
    // header describes what was found rather than asserting where it starts.
    //
    // THE CONTROL IS NO LONGER "[G]" — the letter is read off the live keymap
    // now (see the painting test below), so this test names the HIT rather than
    // the label.
    //
    // ═══ RE-BASED FOR THE WIDER LABEL ═══
    // The box was sized for four characters (`[--]`) and is now sized for SEVEN,
    // because the control carries the unspent count: `[G·2]`, and at worst
    // `[--·11]` for a player who has unbound `show_talents` and banked every
    // point `totalPointsAtLevel(MAX_CHARACTER_LEVEL)` can grant. The width is
    // TRANSCRIBED here rather than imported, the same way test/client/drag.ts's
    // RESERVED table transcribes each panel's close arithmetic: seven glyphs at
    // the 10px monospace's six-pixel advance, plus `drawButton`'s own 6 pixels
    // of padding. If the button is narrowed back to four characters the label
    // silently ellipsises to `[G·…` — a control reporting the wrong count — and
    // this is where that surfaces.
    const WIDEST_LABEL = '[--·11]';
    const TALENTS_BTN_W = WIDEST_LABEL.length * 6 + 6;
    const y = rect.y + Math.floor(HEADER_H / 2);
    const close: number[] = [];
    const talents: number[] = [];
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const hit = charSheetHitAt(rect, x, y);
      if (hit === 'close') close.push(x);
      if (hit === 'talents') talents.push(x);
    }
    expect(talents.length).toBeGreaterThan(0);
    expect(close.length).toBeGreaterThan(0);
    // Contiguous, and strictly LEFT of the close with no overlap: two controls
    // sharing a pixel is a click that closes the sheet when it meant to open the
    // panel, which on this header is the two most similar-looking gestures.
    expect(talents[talents.length - 1] ?? 0).toBe((talents[0] ?? 0) + talents.length - 1);
    expect(talents[talents.length - 1] ?? 0).toBeLessThan(close[0] ?? 0);
    // ...and wide enough for the widest label it can be asked to draw.
    expect(talents).toHaveLength(TALENTS_BTN_W);
  });

  it('does not answer for a point outside the panel', () => {
    expect(charSheetHitAt(rect, rect.x - 1, rect.y + 4)).toBeNull();
    expect(charSheetHitAt(rect, rect.x + rect.w + 40, rect.y + 4)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// One paint, to prove the drawer is wired to the geometry it advertises
// ---------------------------------------------------------------------------

describe('drawing', () => {
  it('paints without touching anything outside its own rect', () => {
    // The context is a recorder, not a canvas. There is deliberately no pixel
    // test in this project; what matters is that the sheet clips to itself, so
    // a long class name cannot bleed onto the map.
    const clips: { x: number; y: number; w: number; h: number }[] = [];
    const calls: string[] = [];
    const stub = new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (prop === 'measureText') return () => ({ width: 20 });
          if (prop === 'rect')
            return (x: number, y: number, w: number, h: number) => {
              clips.push({ x, y, w, h });
            };
          if (prop === 'canvas') return undefined;
          return (...args: unknown[]) => {
            calls.push(`${prop}(${args.length})`);
          };
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;

    const rect = charSheetRect({ width: 640, height: 400, top: 20, bottom: 360 });
    if (rect === null) throw new Error('unreachable');

    drawCharSheet({
      tab: SheetTab.General,
      ctx: stub,
      // No art at all, which is the honest state of the ability icons today:
      // every missing-art fallback path in the sheet runs here.
      sprites: { sprite: () => undefined },
      rect,
      rows: charSheetRows(sheet(), SheetTab.General),
      hoveredClose: false,
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(clips[0]).toEqual({ x: rect.x, y: rect.y, w: rect.w, h: rect.h });
    // Every save is paired. An unbalanced one leaks a font, an alignment or an
    // alpha into every painter that runs later in the frame, and it presents as
    // a bug in whichever surface happens to be drawn next.
    expect(calls.filter((c) => c.startsWith('save(')).length).toBe(
      calls.filter((c) => c.startsWith('restore(')).length,
    );
  });

  it('paints the talent control with the LIVE key, not with a hard-coded [G]', () => {
    // ═══ THE MNEMONIC IS A DEFAULT, NOT A FACT ═══
    // `show_talents` is rebindable, so a label written into the source as '[G]'
    // becomes a lie the first time somebody uses the Keys screen — and a
    // mnemonic that names the wrong key is worse than none, because the player
    // believes it and presses it. `measureText` answers six pixels a character
    // here, matching the 10px monospace, so `fitText` does not ellipsise the
    // three characters under test.
    function paint(
      keymap: Parameters<typeof charSheetRows>[0]['keymap'],
      unspent?: number,
    ): string[] {
      const texts: string[] = [];
      const stub = new Proxy(
        {},
        {
          get: (_target, prop: string) => {
            if (prop === 'measureText') return (text: string) => ({ width: text.length * 6 });
            if (prop === 'fillText')
              return (text: string) => {
                texts.push(text);
              };
            if (prop === 'canvas') return undefined;
            return () => {};
          },
          set: () => true,
        },
      ) as unknown as CanvasRenderingContext2D;

      const rect = charSheetRect({ width: 640, height: 400, top: 20, bottom: 360 });
      if (rect === null) throw new Error('unreachable');
      drawCharSheet({
        tab: SheetTab.General,
        ctx: stub,
        sprites: { sprite: () => undefined },
        rect,
        rows: charSheetRows(sheet({ keymap }), SheetTab.General),
        hoveredClose: false,
        keymap,
        unspent,
      });
      return texts;
    }

    expect(paint(DEFAULT_KEYMAP)).toContain(`[${labelFor('show_talents', DEFAULT_KEYMAP)}]`);
    expect(paint(compileKeymap(ACTIONS, { show_talents: ['key:z'] }))).toContain('[Z]');

    // ═══ AND IT CARRIES THE COUNT WHILE POINTS ARE WAITING ═══
    // Two working affordances routed to the spend screen without ever saying how
    // many points were behind them; this is one of them (the escape menu's row 3
    // is the other). LevelupDialog.lua:757-784 puts the number in the button's
    // own text. NOT ELLIPSISED: `measureText` answers six pixels a character
    // here, matching the 10px monospace, so a label that came back as `[G·…`
    // would mean the button had been narrowed below what its widest label needs.
    const key = labelFor('show_talents', DEFAULT_KEYMAP);
    expect(paint(DEFAULT_KEYMAP, 2)).toContain(`[${key}·2]`);
    expect(paint(DEFAULT_KEYMAP, 11)).toContain(`[${key}·11]`);
    // At zero it is the bare control it has always been — a `[G·0]` on every
    // open is furniture, which is the same conditional the sheet's points ROW
    // keeps (Minimalist.lua:1512-1516).
    expect(paint(DEFAULT_KEYMAP, 0)).toContain(`[${key}]`);
  });

  it('still paints, and still clips, in a panel too small for everything', () => {
    // The drop policy is exercised here rather than asserted directly: what
    // matters is that a short sheet never paints outside its rect and never
    // throws on the way to giving up.
    const clips: { x: number; y: number; w: number; h: number }[] = [];
    const stub = new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (prop === 'measureText') return () => ({ width: 20 });
          if (prop === 'rect')
            return (x: number, y: number, w: number, h: number) => {
              clips.push({ x, y, w, h });
            };
          if (prop === 'canvas') return undefined;
          return () => {};
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;

    const rect = { x: 4, y: 4, w: 176, h: 96 };
    drawCharSheet({
      tab: SheetTab.General,
      ctx: stub,
      sprites: { sprite: () => undefined },
      rect,
      rows: charSheetRows(sheet(), SheetTab.General),
      hoveredClose: true,
    });

    expect(clips[0]).toEqual(rect);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTHING ON THIS SHEET IS ELLIPSISED, AT ANY VIEWPORT THE PANEL OPENS IN.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * FOUND BY PAINTING IT RATHER THAN BY READING IT. The stat columns were the
 * suspect -- two columns of a 328-wide panel is 151 pixels each -- and they turn
 * out to be fine at every size. What clipped was the TALENT row, on every
 * viewport including 1280x720:
 *
 *     AP 5 · melee/personal · ready   ->   AP 5 · melee/persona…
 *
 * So the sheet was losing the cooldown word on every screen anyone plays on,
 * and the cooldown word is the one thing on that row a player is reading it
 * FOR: it is the difference between a talent they can press this turn and one
 * they cannot. `ready` is a word and not only a colour for exactly that reason
 * (see the painter), and then the word was cut off.
 *
 * TWO CAUSES, AND BOTH ARE FIXED:
 *   1. the panel was a FIXED 328 wide and never used the room a bigger window
 *      gave it, so growing the viewport could not help;
 *   2. the meta line ellipsised its TAIL, which throws away the cooldown to
 *      keep the range -- exactly backwards.
 *
 * `measureText` answers six pixels a character, which is what the 10px
 * monospace actually measures, so a `…` in this output means the real client
 * would draw one.
 */
describe('the sheet shows what it says it shows', () => {
  /**
   * PAINTS ONE TAB. Defaults to General because most of these cases are about
   * the identity block, and takes the tab explicitly because a sheet with pages
   * cannot be asked "what does it draw" without saying which page.
   */
  function painted(
    width: number,
    height: number,
    over: Partial<CharSheetView> = {},
    tab: SheetTab = SheetTab.General,
  ): string[] {
    const texts: string[] = [];
    const stub = new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (prop === 'measureText') return (text: string) => ({ width: text.length * 6 });
          if (prop === 'fillText')
            return (text: string) => {
              texts.push(text);
            };
          if (prop === 'canvas') return undefined;
          return () => {};
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;

    const rect = charSheetRect({ width, height, top: 20, bottom: height - 40 });
    if (rect === null) throw new Error(`no rect at ${String(width)}x${String(height)}`);
    drawCharSheet({
      tab,
      ctx: stub,
      sprites: { sprite: () => undefined },
      rect,
      rows: charSheetRows(sheet(over), tab),
      hoveredClose: false,
    });
    return texts;
  }

  /**
   * THE FLOOR AND THE CEILING AND THREE SIZES BETWEEN. The floor is the one that
   * matters -- 640x320 is the smallest window this client draws into -- but the
   * bug this describes was WORST at the ceiling, because a fixed-width panel
   * gets no better when the screen does. Testing only the floor would have
   * missed it for as long as it has been missed.
   */
  const VIEWPORTS = [
    [640, 320],
    [640, 400],
    [772, 480],
    [1024, 600],
    [1280, 720],
  ] as const;

  it('ellipsises nothing at any viewport', () => {
    const bad: string[] = [];
    for (const [w, h] of VIEWPORTS) {
      for (const text of painted(w, h)) {
        if (text.includes('…')) bad.push(`${String(w)}x${String(h)}: ${text}`);
      }
    }
    expect(bad).toEqual([]);
  });

  /**
   * AND THE STRIP SURVIVES A NARROW PANEL WITHOUT LYING ABOUT WHICH TAB IS
   * WHICH. Five tabs at `SHEET_MIN_W` leave about five characters each, and an
   * ellipsised `[D]e…` beside `[E]q…` is two tabs a player cannot tell apart.
   * The bracketed letter is what identifies a tab, so it is what survives.
   */
  it('falls back to the bracketed letter rather than an ellipsis', () => {
    const wide = painted(1280, 720, {}, SheetTab.General);
    expect(wide, 'a wide panel should print the whole word').toContain('[G]eneral');

    const narrow = painted(640, 320, {}, SheetTab.General);
    const tabs = narrow.filter((text) => text.startsWith('['));
    expect(tabs.length, 'the strip drew nothing').toBeGreaterThan(0);
    for (const text of tabs) {
      expect(text, `an ellipsised tab label: ${text}`).not.toContain('…');
    }
  });

  it('keeps the cooldown word on every talent row, which is what the row is read for', () => {
    for (const [w, h] of VIEWPORTS) {
      const texts = painted(w, h, {}, SheetTab.Talents);
      // A meta line is the only thing on this sheet with the middot separator
      // -- except the `[G·2]` button, which no case here arms and which is
      // excluded by shape rather than by hoping. NOT `startsWith('AP ')`: a
      // talent costing nothing reads `free`, and matching on the cost would
      // have silently skipped it.
      const metas = texts.filter((text) => text.includes(' · ') && !text.startsWith('['));
      expect(metas.length, `${String(w)}x${String(h)} meta count`).toBe(LOADOUT.length);
      for (const meta of metas) {
        expect(meta, `${String(w)}x${String(h)}`).toMatch(/(ready|turns?)$/);
      }
    }
  });

  it('keeps every talent NAME whole as well', () => {
    // The name is the other half of the identification; a clipped one makes two
    // talents with a shared prefix indistinguishable.
    for (const [w, h] of VIEWPORTS) {
      const texts = painted(w, h, {}, SheetTab.Talents);
      for (const talentDef of LOADOUT) {
        expect(texts, `${String(w)}x${String(h)}`).toContain(talentDef.name);
      }
    }
  });

  it('still shows every stat label and value in full', () => {
    // The columns were never the bug, and this is what keeps a fix aimed at the
    // talent rows from paying for itself by squeezing them.
    // EVERY STAT TAB, because the fifteen rows live on three pages now. A test
    // that painted only General would pass while Attack and Defence drew nothing.
    const texts = [SheetTab.General, SheetTab.Attack, SheetTab.Defence].flatMap((tab) =>
      painted(640, 320, {}, tab),
    );
    for (const row of SELF_ROWS) {
      expect(texts, row.label).toContain(row.label);
      expect(texts, row.value).toContain(row.value);
    }
  });

  it('uses the room a larger window gives it', () => {
    // A panel that is the same size on a 1280 screen as on a 640 one is not
    // "consistent", it is ignoring the window. This is the property that makes
    // the ellipsis fix hold as content grows rather than being tuned to today's
    // longest string.
    const small = charSheetRect({ width: 640, height: 400, top: 20, bottom: 360 });
    const large = charSheetRect({ width: 1280, height: 720, top: 20, bottom: 680 });
    expect(small).not.toBeNull();
    expect(large).not.toBeNull();
    expect(large?.w ?? 0).toBeGreaterThan(small?.w ?? 0);
  });

  it('never grows wider than the window it is centred in', () => {
    for (const [w, h] of VIEWPORTS) {
      const rect = charSheetRect({ width: w, height: h, top: 20, bottom: h - 40 });
      expect(rect?.w ?? 0, `${String(w)}x${String(h)}`).toBeLessThanOrEqual(w);
      expect(rect?.x ?? 0, `${String(w)}x${String(h)} left`).toBeGreaterThanOrEqual(0);
      expect(
        (rect?.x ?? 0) + (rect?.w ?? 0),
        `${String(w)}x${String(h)} right`,
      ).toBeLessThanOrEqual(w);
    }
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *   NOTHING IS HIDDEN AT THE VIEWPORT THE GAME IS ACTUALLY PLAYED AT.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A player reported "the characteristics page improperly shows info due to
   * lack of space", and this sheet answers that by DROPPING a whole section and
   * saying so in a row. The reply is honest; the behaviour is the bug.
   *
   * ═══ THE VIEWPORT IS NOT THE WINDOW, AND ASSUMING IT WAS COST A ROUND ═══
   * The screenshot came from a 1538-pixel window, so the first fix widened the
   * panel against 1538 and reported a 1200-pixel sheet. The panel never sees
   * that number. `createRenderer` draws into a LOGICAL BACKBUFFER of
   * `tilesW * TILE_PX`, and a 20x10-tile floor at integer scale on that window
   * is 768x384 — so the sheet is 729 wide, and the band between the HUD docks
   * caps it at 214 TALL however wide the monitor is.
   *
   * Height is the binding constraint and no sizing rule can move it. What fixes
   * the drop is COLUMNS, which is what ToME's general tab does — four of them,
   * at CharacterSheet.lua:602-603, :675-676, :795-796 and :844-845.
   *
   * These cases assert at the real backbuffer rather than a flattering one.
   */
  describe('at the backbuffer this game actually renders', () => {
    /** 20x10 tiles at TILE_PX 32 — the floor every device lands on or above. */
    const REAL_W = 768;
    const REAL_H = 384;

    it('hides no section, and says so about nothing', () => {
      const hidden = painted(REAL_W, REAL_H).filter((text) => text.includes('panel too small'));
      expect(hidden, `still dropping at the real viewport: ${hidden.join(', ')}`).toEqual([]);
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * AND AT THE FLOOR, ON EVERY TAB — which is the size that catches things.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `REAL_W x REAL_H` is what a 1538x769 device lands on. It is not the
     * smallest: `DEFAULT_VIEWPORT` is `{ tilesW: 20, tilesH: 10 }` and
     * `minLogicalH = tilesH * TILE_PX`, so 640x320 is the floor.
     *
     * The distinction is not academic. `ui/inventory.ts` worked its paper-doll
     * budget against a 480-pixel floor, concluded that shedding slots was
     * "unreachable at any viewport this client renders", and sheds three of them
     * at 320 — a claim that survived because nothing ever measured there.
     *
     * EVERY TAB, because the sheet has five now and a page that fits on one is
     * no evidence about the others. Talents is the long one and Equipment lists
     * seven slots whether or not anything is in them.
     */
    it('hides nothing at the smallest window this client draws, on any tab', () => {
      for (const tab of SHEET_TABS) {
        const hidden = painted(640, 320, {}, tab).filter((text) =>
          text.includes('panel too small'),
        );
        expect(hidden, `${String(tab)} drops at the 640x320 floor`).toEqual([]);
      }
    });

    it('still shows a row from every section at that size', () => {
      // ONE PAGE AT A TIME, and every page must draw its own heading. COMBAT is
      // gone — it was ToME's Attack and Defense tabs collapsed, and they are
      // tabs again.
      for (const tab of SHEET_TABS) {
        const texts = painted(REAL_W, REAL_H, {}, tab);
        expect(texts, `${String(tab)} drew no heading`).toContain(
          tab === SheetTab.Defence ? 'DEFENCE' : String(tab).toUpperCase(),
        );
      }
    });

    /**
     * AND THE COLUMNS STAY WIDE ENOUGH TO READ. More columns helps only while
     * each still holds a talent row's meta line — four columns of slivers costs
     * the cooldown word, which is the regression `COL_MIN_W` is derived to
     * prevent, and which an earlier version of this change caused.
     */
    /**
     * ═══════════════════════════════════════════════════════════════════════════
     * A FULL BAR STILL FITS THE FLOOR — and the failure here is total, not partial.
     * ═══════════════════════════════════════════════════════════════════════════
     *
     * `TALENTS_PER_CLASS_MAX` is the most actives a class may own, and the Talents
     * tab has to draw all of them on the smallest window this client renders
     * (`DEFAULT_VIEWPORT` is `tilesH: 10`, so 640x320).
     *
     * ═══ WHY THIS IS WORTH A TEST RATHER THAN A GLANCE ═══
     * `DROP_ORDER` sheds a WHOLE SECTION, so the failure mode is not "the last two
     * talents are missing" — it is `shown=0` and one line of grey text. A player
     * at the floor would open the Talents tab and find no talents at all.
     *
     * Measured: 14 fit and 18 do not. The cap is 12, so there are two talents of
     * headroom and no more. A class gaining a fourth discipline, or the cap being
     * raised, walks into that edge — this is the line that says so first.
     */
    it('draws a full-cap loadout at the floor, on the Talents tab', () => {
      // ONE REAL TALENT AS THE BASE. An indexed read is a maybe under
      // `noUncheckedIndexedAccess`, and spreading a maybe makes every field
      // optional — which is not a `LoadoutTalent` and not what the sheet is
      // handed in production.
      const base = LOADOUT[0];
      if (base === undefined) throw new Error('the fixture has no talents');
      const full = Array.from({ length: TALENTS_PER_CLASS_MAX }, (_, i) => ({
        ...base,
        id: `talent:full${String(i)}`,
        name: `Talent ${String(i)}`,
      }));
      const texts = painted(640, 320, { loadout: full }, SheetTab.Talents);

      expect(
        texts.filter((t) => t.includes('panel too small')),
        'the Talents tab drops the whole section at the floor with a full bar',
      ).toEqual([]);
      for (const talent of full) {
        expect(texts, `${talent.name} is missing`).toContain(talent.name);
      }
    });

    it('keeps every talent meta line whole at that size', () => {
      const texts = painted(REAL_W, REAL_H, {}, SheetTab.Talents);
      const metas = texts.filter((text) => text.includes(' · ') && !text.startsWith('['));
      expect(metas.length, 'a talent row lost its meta line').toBe(LOADOUT.length);
      for (const meta of metas) expect(meta).toMatch(/(ready|turns?)$/);
      expect(
        texts.filter((text) => text.includes('…')),
        'something was ellipsised',
      ).toEqual([]);
    });
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A TALENT DOES, WHICH THE SHEET WROTE DOWN NOWHERE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The sheet lists four talents by name, cost, range and cooldown. The server
 * sends a sentence for each and this panel never had the width to draw it, so
 * the only way to find out what `Iron Curtain` did was to press it and spend
 * the turn.
 */
describe('the character sheet card', () => {
  const RECT = { x: 0, y: 0, w: 460, h: 268 };

  /** The centre of the first talent row, found through the placer. */
  function talentPoint(rows: readonly SheetRow[]) {
    for (let y = RECT.y; y < RECT.y + RECT.h; y += 1) {
      for (let x = RECT.x; x < RECT.x + RECT.w; x += 8) {
        const card = charSheetTipAt(RECT, rows, x, y);
        if (card !== null) return { x, y, card };
      }
    }
    throw new Error('no talent row found');
  }

  it('describes the talent under the pointer', () => {
    const { card } = talentPoint(charSheetRows(sheet(), SheetTab.Talents));
    expect(card.lines.join(' ')).toContain('A talent.');
  });

  it('names it with its rank, which the row has no room for', () => {
    const { card } = talentPoint(charSheetRows(sheet(), SheetTab.Talents));
    expect(card.title).toMatch(/\d+\/\d+$/);
  });

  it('carries the FULL meta, including a range the row may have conceded', () => {
    // `talentMeta` drops the range on a narrow column. A card is sized to its
    // own content and never has to, so this is the one place all three fields
    // are always present.
    const { card } = talentPoint(charSheetRows(sheet(), SheetTab.Talents));
    expect(card.meta?.split(' · ').length).toBe(3);
  });

  it('shows the NEXT rank too, which is the decision being made', () => {
    // The sheet's `[G]` opens the levelup screen, so somebody reading this panel
    // with a point in hand is deciding where to put it.
    const { card } = talentPoint(charSheetRows(sheet(), SheetTab.Talents));
    expect((card.nextLines ?? []).join(' ')).toContain('slightly better');
  });

  it('says nothing about the next rank at max, rather than repeating itself', () => {
    // A card showing the same sentence twice reads as a rendering fault.
    const maxed = LOADOUT.map((t) => ({ ...t, level: TALENT_MAX_LEVEL }));
    const { card } = talentPoint(charSheetRows(sheet({ loadout: maxed }), SheetTab.Talents));
    expect(card.nextLines ?? []).toEqual([]);
  });

  it('answers null off the rows', () => {
    expect(charSheetTipAt(RECT, charSheetRows(sheet(), SheetTab.Talents), -20, -20)).toBeNull();
  });

  it('never describes a row the panel conceded', () => {
    // ═══ THE LADDER AND THE CARD READ THE SAME PLACEMENT ═══
    // A short panel sheds whole SECTIONS, and TALENTS is one of them. The card
    // walks the rows `sheetGeometry` actually placed rather than the rows it was
    // handed, so on a panel too short to hold the talents there is nothing to
    // describe and every point answers null — instead of a card appearing over
    // the note that says the section is hidden.
    const tiny = { x: 0, y: 0, w: 460, h: 90 };
    const rows = charSheetRows(sheet(), SheetTab.Talents);
    let answered = 0;
    let described = 0;
    for (let y = tiny.y; y < tiny.y + tiny.h; y += 1) {
      for (let x = tiny.x; x < tiny.x + tiny.w; x += 16) {
        const card = charSheetTipAt(tiny, rows, x, y);
        if (card === null) continue;
        answered += 1;
        if (LOADOUT.some((t) => card.title.startsWith(t.name))) described += 1;
      }
    }
    // Whatever it answered, it answered about a talent that is really placed —
    // and on this panel it answers about none at all.
    expect(described).toBe(answered);
    expect(answered).toBe(0);
  });
});
