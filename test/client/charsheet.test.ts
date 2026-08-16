/// <reference lib="dom" />

import { describe, expect, it } from 'vitest';

import {
  charSheetHitAt,
  charSheetRect,
  charSheetRows,
  drawCharSheet,
  SHEET_MIN_H,
  SheetRowKind,
  SheetSection,
} from '../../src/client/ui/charsheet.ts';
import { HEADER_H } from '../../src/client/ui/panel.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import { ResourceKind, TalentShape } from '../../src/shared/protocol.ts';
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
const SELF_ROWS = [
  { label: 'Strength', value: '14' },
  { label: 'Dexterity', value: '11' },
  { label: 'Constitution', value: '13' },
  { label: 'Magic', value: '10' },
  { label: 'Willpower', value: '12' },
  { label: 'Cunning', value: '10' },
  { label: 'Accuracy', value: '19' },
  { label: 'Damage', value: '12–13' },
  { label: 'APR', value: '2' },
  { label: 'Crit. chance', value: '3%' },
  { label: 'Armour', value: '4' },
  { label: 'Defence', value: '8' },
  { label: 'Physical save', value: '9' },
  { label: 'Spell save', value: '5' },
  { label: 'Mental save', value: '6' },
] as const;

function selfView(over: Partial<InspectView> = {}): InspectView {
  return {
    id: 'actor_a',
    name: 'Dalt',
    className: 'The Watchman',
    kind: 'detective',
    hp: 41.000000000000014,
    maxHp: 58,
    effects: [],
    rows: SELF_ROWS.map((row) => ({ label: row.label, value: row.value })),
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
  it('emits General, then Combat, then Talents, and nothing else', () => {
    // ToME's spine: General (CharacterSheet.lua:605-625), Attack (:935-941) and
    // Defense (:1303-1321) — which collapse into one COMBAT section here
    // because the server sends them as one ordered list — then Talents.
    expect(sections(charSheetRows(sheet()))).toEqual([
      SheetSection.General,
      SheetSection.Combat,
      SheetSection.Talents,
    ]);
  });

  it('opens with identity, then Life, then the pool — never the numbers first', () => {
    const rows = charSheetRows(sheet());
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
    const rows = charSheetRows(sheet({ view: selfView({ className: undefined }) }));
    expect(fieldLabels(rows)).not.toContain('Class');
    expect(fieldLabels(rows).slice(0, 2)).toEqual(['Name', 'Level']);
  });

  it('keeps the server’s fifteen rows in the server’s order, unsorted', () => {
    const rows = charSheetRows(sheet());
    const labels = fieldLabels(rows);
    const combat = labels.slice(labels.indexOf('Strength'));
    expect(combat).toEqual(SELF_ROWS.map((row) => row.label));
    // Belt and braces: an alphabetising client would put APR first.
    expect(combat[0]).toBe('Strength');
  });

  it('rounds hp UP, the same way every other surface in the client does', () => {
    // ui/tooltip.ts:143-155: the damage pipeline produces fractional hp, and one
    // body reading 41 in the party pane and 42 here would make a player
    // reasonably conclude one of them is lying.
    const rows = charSheetRows(sheet());
    const life = rows.find((row) => row.kind === SheetRowKind.Field && row.label === 'Life');
    expect(life).toEqual({ kind: SheetRowKind.Field, label: 'Life', value: '42/58' });
  });

  it('omits the pool entirely rather than drawing an empty row for it', () => {
    const rows = charSheetRows(sheet({ resource: null }));
    expect(fieldLabels(rows)).toEqual([
      'Name',
      'Class',
      'Level',
      'Experience',
      'Life',
      ...SELF_ROWS.map((r) => r.label),
    ]);
  });

  it('names the pool by its own name, as ToME labels each resource', () => {
    const rows = charSheetRows(
      sheet({
        resource: pool({ kind: ResourceKind.Reagents, current: 3, max: 8, discrete: true }),
      }),
    );
    expect(rows).toContainEqual({ kind: SheetRowKind.Field, label: 'Reagents', value: '3/8' });
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
    const labels = fieldLabels(charSheetRows(sheet()));
    expect(labels.indexOf('Level')).toBeGreaterThan(labels.indexOf('Class'));
    expect(labels.indexOf('Experience')).toBe(labels.indexOf('Level') + 1);
    expect(labels.indexOf('Life')).toBe(labels.indexOf('Experience') + 1);
  });

  it('prints the two xp numbers rather than ToME’s percentage', () => {
    expect(labelled(charSheetRows(sheet()), 'Experience')[0]?.value).toBe('61/174');
    expect(labelled(charSheetRows(sheet()), 'Level')[0]?.value).toBe('4');
  });

  it('says “top level” instead of dividing by the cap’s zero denominator', () => {
    // `sendProgress` sends xpToNext = 0 at MAX_CHARACTER_LEVEL as a SENTINEL:
    // there is no next level and xp keeps accumulating, so any positive
    // denominator would draw a fraction creeping towards a level that never
    // arrives. It is a fact to handle, never a number to divide by.
    const rows = charSheetRows(
      sheet({ progress: progressFrame({ level: 10, xp: 900, xpToNext: 0 }) }),
    );
    expect(labelled(rows, 'Experience')[0]?.value).toBe('900 — top level');
  });

  it('draws no level line at all before the first progress frame', () => {
    // Null is a one-frame window on connect, not a level-0 character. A row
    // reading "Level: 0" in that window is a wrong number stated confidently.
    const labels = fieldLabels(charSheetRows(sheet({ progress: null })));
    expect(labels).not.toContain('Level');
    expect(labels).not.toContain('Experience');
    expect(labels).not.toContain('Talent points');
  });

  it('hides the points row at zero and shows it above zero, naming the key', () => {
    // ToME's own conditional: uiset/Minimalist.lua:1512-1516 draws the levelup
    // glow and :1587-1589 makes its hotspot clickable only under
    // `player.unused_talents > 0 or ...`. A row reading "0 points" on every open
    // is furniture within one session.
    expect(fieldLabels(charSheetRows(sheet()))).not.toContain('Talent points');

    const rows = charSheetRows(sheet({ progress: progressFrame({ unspent: 3 }) }));
    const points = labelled(rows, 'Talent points')[0];
    expect(points).toBeDefined();
    expect(points?.value).toContain('3 points');
    // IT NAMES THE KEY. This row is the only place a player who has never opened
    // the talent panel learns that it exists — an unspent point is a call to
    // action, and a call to action with no instruction is a stat.
    expect(points?.value).toContain('g');
  });

  it('says “1 point”, not “1 points”', () => {
    const rows = charSheetRows(sheet({ progress: progressFrame({ unspent: 1 }) }));
    expect(labelled(rows, 'Talent points')[0]?.value).toContain('1 point —');
  });

  it('puts the points row under Experience and still above Life', () => {
    const labels = fieldLabels(charSheetRows(sheet({ progress: progressFrame({ unspent: 2 }) })));
    expect(labels.indexOf('Talent points')).toBe(labels.indexOf('Experience') + 1);
    expect(labels.indexOf('Life')).toBe(labels.indexOf('Talent points') + 1);
  });
});

// ---------------------------------------------------------------------------
// The gathering row
// ---------------------------------------------------------------------------

describe('charSheetRows while the round trip is out', () => {
  it('says “gathering…” and never returns an empty list', () => {
    const rows = charSheetRows(sheet({ view: null }));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).toContainEqual({ kind: SheetRowKind.Note, text: 'gathering…' });
  });

  it('still shows the talents and the pool, which come from other frames', () => {
    // The loadout and the resource are unicast on connect and are NOT part of
    // the `inspect` round trip, so hiding them while the answer is in flight
    // would blank three quarters of a sheet that is already fully known.
    const rows = charSheetRows(sheet({ view: null }));
    expect(sections(rows)).toEqual([SheetSection.General, SheetSection.Talents]);
    expect(fieldLabels(rows)).toEqual(['Resolve']);
    expect(rows.flatMap((row) => (row.kind === SheetRowKind.Talent ? [row] : []))).toHaveLength(4);
  });

  it('still says something when literally nothing has arrived', () => {
    const rows = charSheetRows({
      view: null,
      resource: null,
      loadout: [],
      cooldowns: {},
      progress: null,
    });
    expect(rows).toEqual([
      { kind: SheetRowKind.Section, label: SheetSection.General },
      { kind: SheetRowKind.Note, text: 'gathering…' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The talent block — composed client-side from three frames
// ---------------------------------------------------------------------------

describe('the talent rows', () => {
  function talentRows(view: CharSheetView) {
    return charSheetRows(view).flatMap((row) => (row.kind === SheetRowKind.Talent ? [row] : []));
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
    expect(charSheetHitAt(rect, rect.x + 4, rect.y + 4)).toBeNull();
  });

  it('offers the [G] control immediately left of the close, and never over it', () => {
    // ToME's own discoverable route to its levelup screen is a button on the
    // character sheet (CharacterSheet.lua:99's "[L]evelup"). A SCAN across the
    // header describes what was found rather than asserting where it starts.
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
      ctx: stub,
      // No art at all, which is the honest state of the ability icons today:
      // every missing-art fallback path in the sheet runs here.
      sprites: { sprite: () => undefined },
      rect,
      rows: charSheetRows(sheet()),
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
      ctx: stub,
      sprites: { sprite: () => undefined },
      rect,
      rows: charSheetRows(sheet()),
      hoveredClose: true,
    });

    expect(clips[0]).toEqual(rect);
  });
});
