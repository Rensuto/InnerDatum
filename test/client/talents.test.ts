/// <reference lib="dom" />

import { describe, expect, it } from 'vitest';

import {
  TALENT_PANEL_MARGIN,
  TALENT_PANEL_MIN_H,
  TALENT_PANEL_MIN_W,
  TalentHitKind,
  TalentRowKind,
  drawTalentPanel,
  pressSpend,
  talentPanelGeometry,
  talentPanelHitAt,
  talentPanelRect,
  talentPanelRows,
} from '../../src/client/ui/talents.ts';
import { PROTOCOL_VERSION } from '../../src/shared/version.ts';
import { TalentShape } from '../../src/shared/protocol.ts';
import { TALENT_MAX_LEVEL } from '../../src/shared/progression.ts';
import type { TalentPanelView, TalentRow } from '../../src/client/ui/talents.ts';
import type { LoadoutTalent, ProgressMsg } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TALENT PANEL, READ THE WAY A CLICK READS IT. NO PIXELS ARE ASSERTED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * vitest.config.ts is explicit that there is deliberately no jsdom and no canvas
 * here, and nothing below paints to anything real. What is tested is the layer
 * where a bug on this screen is IRREVERSIBLE or INVISIBLE:
 *
 *   THE ORDER        the loadout's order IS the hotbar's order, and slot 1 is
 *                    index 0. A panel that re-ranked its rows would teach a
 *                    different order from the one under the player's fingers.
 *   THE HIT TEST     the painter and the pointer read ONE geometry function, at
 *                    several viewport sizes. Two copies of that arithmetic is a
 *                    `+` that lands a row above where it is drawn, and the bug
 *                    only shows up on somebody else's window (ui/partypanel.ts
 *                    :93-99).
 *   THE `+`'S RULES  absent at the cap, absent with an empty hand, and requiring
 *                    a SECOND press on the same row before anything goes out.
 *                    A spend is irreversible: there is no refund verb.
 *   THE DIFF         both `desc` and `descNext` are drawn, and a capped talent
 *                    draws `desc` alone with no arrow. A talent level that shows
 *                    no consequence is the lie this panel exists to prevent.
 *   THE BANDS        the panel rect NEVER touches the hotbar or the resource
 *                    strip. That is the panel-not-modal property made mechanical
 *                    and it is the test that catches a later "just make it a bit
 *                    taller".
 *
 * The hit tests SCAN rather than assert coordinates, for the reason
 * test/client/partypanel.test.ts:56-61 gives: an assertion that the `+` starts at
 * x=300 would pass while it was drawn at x=298, because it would be testing the
 * test's own copy of the arithmetic.
 *
 * THE `reference lib="dom"` ON LINE 1 IS REQUIRED and its cost is documented at
 * test/client/turncards.test.ts:51-60.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function talent(over: Partial<LoadoutTalent> & { id: string; name: string }): LoadoutTalent {
  return {
    icon: 'icon_active_ward_rush',
    cost: { ap: 5, mp: 0, resource: 10 },
    cooldownTurns: 3,
    range: 4,
    minRange: 0,
    shape: TalentShape.Single,
    radius: 0,
    level: 1,
    maxLevel: TALENT_MAX_LEVEL,
    desc: 'Hits for 12.',
    descNext: 'Hits for 15.',
    ...over,
  };
}

/**
 * FOUR TALENTS WHOSE LOADOUT ORDER IS THE OPPOSITE OF EVERY ORDER A PANEL MIGHT
 * BE TEMPTED TO IMPOSE: reverse-alphabetical by name AND by id, and DESCENDING
 * by level. Any sort at all reorders this list, so the order assertion cannot
 * pass by accident.
 */
const LOADOUT: readonly LoadoutTalent[] = [
  talent({ id: 'talent:ward_rush', name: 'Ward Rush', level: 4 }),
  talent({ id: 'talent:iron_curtain', name: 'Iron Curtain', level: 3 }),
  talent({ id: 'talent:fog_step', name: 'Fog Step', level: 2 }),
  talent({ id: 'talent:crude_blow', name: 'Crude Blow', level: 1 }),
];

function progressFrame(over: Partial<ProgressMsg> = {}): ProgressMsg {
  return {
    v: PROTOCOL_VERSION,
    t: 'progress',
    level: 6,
    xp: 120,
    xpToNext: 346,
    unspent: 2,
    ...over,
  };
}

function view(over: Partial<TalentPanelView> = {}): TalentPanelView {
  return { loadout: LOADOUT, progress: progressFrame(), ...over };
}

function talentRows(rows: readonly TalentRow[]) {
  return rows.flatMap((row) => (row.kind === TalentRowKind.Talent ? [row] : []));
}

/**
 * A band that comfortably holds everything, so the row tests are about content
 * rather than about the drop policy.
 */
const ROOMY = { width: 640, height: 400, top: 20, bottom: 360 };

function roomyRect() {
  const rect = talentPanelRect(ROOMY);
  if (rect === null) throw new Error('unreachable: the roomy band must hold a panel');
  return rect;
}

// ---------------------------------------------------------------------------
// THE ORDER — slot 1 is index 0, always
// ---------------------------------------------------------------------------

describe('talentPanelRows', () => {
  it('keeps the loadout’s own order and never sorts it', () => {
    // `LoadoutMsg` promises slot 1 is `talents[0]` and asks the client not to
    // re-rank. This panel is where somebody decides which of those four KEYS to
    // improve, so a list in any other order teaches the wrong finger.
    const rows = talentRows(talentPanelRows(view()));
    expect(rows.map((row) => row.name)).toEqual([
      'Ward Rush',
      'Iron Curtain',
      'Fog Step',
      'Crude Blow',
    ]);
    expect(rows.map((row) => row.index)).toEqual([0, 1, 2, 3]);
  });

  it('carries the wire’s own icon key and never one built from the name', () => {
    expect(talentRows(talentPanelRows(view()))[0]?.icon).toBe('icon_active_ward_rush');
  });

  it('shows the points badge only while there is something to spend', () => {
    // ToME's own conditional: uiset/Minimalist.lua:1587-1589 makes its levelup
    // hotspot clickable only under `player.unused_talents > 0 or ...`.
    const withPoints = talentPanelRows(view());
    expect(withPoints[0]).toEqual({ kind: TalentRowKind.Points, unspent: 2 });

    const without = talentPanelRows(view({ progress: progressFrame({ unspent: 0 }) }));
    expect(without.some((row) => row.kind === TalentRowKind.Points)).toBe(false);

    const nothingYet = talentPanelRows(view({ progress: null }));
    expect(nothingYet.some((row) => row.kind === TalentRowKind.Points)).toBe(false);
  });

  it('says something rather than nothing when no loadout has arrived', () => {
    // An empty panel is indistinguishable from a broken one, and the player's
    // next move is to press the key again.
    const rows = talentPanelRows({ loadout: [], progress: null });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe(TalentRowKind.Note);
  });
});

// ---------------------------------------------------------------------------
// THE `+` — what it means for a row to be buyable
// ---------------------------------------------------------------------------

describe('canSpend', () => {
  it('is false for every row when there is no point in hand', () => {
    const rows = talentRows(talentPanelRows(view({ progress: progressFrame({ unspent: 0 }) })));
    expect(rows.map((row) => row.canSpend)).toEqual([false, false, false, false]);
  });

  it('is false for a talent already at its cap, even with points to burn', () => {
    const capped = [
      talent({ id: 'a', name: 'Capped', level: TALENT_MAX_LEVEL }),
      talent({ id: 'b', name: 'Room', level: 2 }),
    ];
    const rows = talentRows(talentPanelRows(view({ loadout: capped })));
    expect(rows.map((row) => row.canSpend)).toEqual([false, true]);
  });

  it('reads the cap off the WIRE and never from a client-side 5', () => {
    // protocol.ts puts `maxLevel` on `LoadoutTalent` precisely so a renderer
    // cannot hold a second copy of an authored number. A talent whose cap is 3
    // is capped at 3 here, whatever `TALENT_MAX_LEVEL` says.
    const odd = [talent({ id: 'a', name: 'Short', level: 3, maxLevel: 3, descNext: null })];
    expect(talentRows(talentPanelRows(view({ loadout: odd })))[0]?.canSpend).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE CONFIRM PRESS — the deviation, stated as a rule
// ---------------------------------------------------------------------------

describe('pressSpend', () => {
  it('sends NOTHING on the first press and arms the row instead', () => {
    // ToME spends live against a cloned actor and commits at the Escape prompt
    // (LevelupDialog.lua:38-53, :121-147, :161-164). We have no draft, so the
    // safety is the second press — and the first must be inert on the wire.
    expect(pressSpend(null, 'talent:fog_step')).toEqual({
      armed: 'talent:fog_step',
      spend: null,
    });
  });

  it('sends exactly one spend on the second press of the SAME row, and disarms', () => {
    const first = pressSpend(null, 'talent:fog_step');
    expect(first.spend).toBeNull();
    const second = pressSpend(first.armed, 'talent:fog_step');
    expect(second).toEqual({ armed: null, spend: 'talent:fog_step' });
    // ...and a third press starts over rather than spending again. Two presses
    // buy one rank; holding the button does not buy four.
    expect(pressSpend(second.armed, 'talent:fog_step').spend).toBeNull();
  });

  it('re-arms on a DIFFERENT row rather than confirming the first one', () => {
    // The case that would be irreversible if it went the other way: a player who
    // armed Ward Rush and then pressed Fog Step has changed their mind, and
    // reading the second press as a confirmation of the FIRST row would
    // permanently spend a point on the talent they just moved away from.
    expect(pressSpend('talent:ward_rush', 'talent:fog_step')).toEqual({
      armed: 'talent:fog_step',
      spend: null,
    });
  });
});

// ---------------------------------------------------------------------------
// THE BAND — the panel-not-modal property, made mechanical
// ---------------------------------------------------------------------------

describe('talentPanelRect', () => {
  /**
   * The bottom bands, as main.ts stacks them: the hotbar, then the resource
   * pips, then two prose lines. `panelBand` derives `bottom` from those modules'
   * own exported heights and this panel is handed the result — so the property
   * under test is that the panel NEVER crosses whatever bottom it was given, at
   * any size, for any band.
   */
  const SIZES = [
    { width: 640, height: 400, top: 20, bottom: 300 },
    { width: 800, height: 600, top: 96, bottom: 470 },
    { width: 480, height: 360, top: 24, bottom: 250 },
    { width: 1280, height: 720, top: 100, bottom: 560 },
    { width: 360, height: 300, top: 12, bottom: 200 },
  ] as const;

  it('never crosses the top or the bottom of its band, at any viewport size', () => {
    // ═══ THIS IS THE TEST THAT CATCHES "just make it a bit taller" ═══
    // The whole design is that a player reading their talents holds nobody up,
    // and the mechanical half of that is that every control stays visible and
    // pressable underneath the panel. A panel that reached the hotbar would be a
    // modal wearing a panel's clothes.
    for (const size of SIZES) {
      const rect = talentPanelRect(size);
      if (rect === null) continue;
      expect(rect.y, `${size.width}x${size.height}`).toBeGreaterThanOrEqual(size.top);
      expect(rect.y + rect.h, `${size.width}x${size.height}`).toBeLessThanOrEqual(size.bottom);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w).toBeLessThanOrEqual(size.width);
    }
  });

  it('clamps the band against the viewport, not just against what it was told', () => {
    // A caller holding a stale viewport size must not be able to push the panel
    // off the bottom, where its close button would be unreachable.
    const rect = talentPanelRect({ width: 640, height: 240, top: 20, bottom: 900 });
    if (rect === null) throw new Error('unreachable');
    expect(rect.y + rect.h).toBeLessThanOrEqual(240);
  });

  it('is anchored to the TOP of the band, so it misses the centred sheet', () => {
    // ui/charsheet.ts centres itself vertically in the same band. Two panels
    // centred on the same point sit exactly on top of each other the moment a
    // player opens both, which is a supported state — `c` and `g` are
    // independent toggles.
    const rect = roomyRect();
    expect(rect.y).toBe(ROOMY.top + TALENT_PANEL_MARGIN);
  });

  it('gives up rather than drawing a panel taller or wider than the band', () => {
    expect(
      talentPanelRect({ width: 640, height: 400, top: 20, bottom: 20 + TALENT_PANEL_MIN_H }),
    ).toBeNull();
    expect(
      talentPanelRect({ width: TALENT_PANEL_MIN_W, height: 400, top: 20, bottom: 360 }),
    ).toBeNull();
  });

  it('opens at exactly the minimum band, so the constant is a real edge', () => {
    const tight = TALENT_PANEL_MIN_H + TALENT_PANEL_MARGIN * 2;
    expect(talentPanelRect({ width: 640, height: 400, top: 0, bottom: tight })).not.toBeNull();
    expect(talentPanelRect({ width: 640, height: 400, top: 0, bottom: tight - 1 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE HIT TEST — one copy of the arithmetic, at several sizes
// ---------------------------------------------------------------------------

describe('talentPanelHitAt', () => {
  it('answers with the row the painter placed, at every viewport size', () => {
    // ═══ THE TWO-COPIES-OF-THE-ARITHMETIC BUG, ASKED DIRECTLY ═══
    // The geometry the painter reads is walked, and every placed row's own
    // centre is put back through the hit test. Anything that computed the two
    // separately would disagree here on at least one of these sizes, which is
    // exactly how the bug presents: fine on the author's window, wrong on
    // somebody else's.
    for (const size of [
      { width: 640, height: 400, top: 20, bottom: 360 },
      { width: 800, height: 600, top: 96, bottom: 470 },
      { width: 500, height: 380, top: 24, bottom: 260 },
      { width: 1280, height: 720, top: 100, bottom: 560 },
    ]) {
      const rect = talentPanelRect(size);
      if (rect === null) continue;
      const rows = talentPanelRows(view());
      const geometry = talentPanelGeometry(rect, rows);

      for (const placed of geometry.placed) {
        if (placed.row.kind !== TalentRowKind.Talent) continue;
        // The left edge of the row, clear of the `+` on the right.
        const hit = talentPanelHitAt(
          rect,
          rows,
          placed.rect.x + 2,
          placed.rect.y + Math.floor(placed.rect.h / 2),
        );
        expect(hit, `${size.width}x${size.height} row ${placed.row.index}`).toEqual({
          kind: TalentHitKind.Row,
          index: placed.row.index,
        });

        if (placed.plus === null) continue;
        const onPlus = talentPanelHitAt(
          rect,
          rows,
          placed.plus.x + Math.floor(placed.plus.w / 2),
          placed.plus.y + Math.floor(placed.plus.h / 2),
        );
        expect(onPlus, `${size.width}x${size.height} plus ${placed.row.index}`).toEqual({
          kind: TalentHitKind.Spend,
          index: placed.row.index,
          talentId: placed.row.id,
        });
      }
    }
  });

  it('hands back ascending row indices as the pointer walks down the panel', () => {
    // A SCAN down the left edge, describing what was found rather than asserting
    // where each row starts. Each index appears in exactly one contiguous run: a
    // repeat would mean two rows interleaved, a gap would mean one is
    // unreachable.
    const rect = roomyRect();
    const rows = talentPanelRows(view());
    const seen: number[] = [];
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      const hit = talentPanelHitAt(rect, rows, rect.x + 10, y);
      if (hit === null || hit.kind !== TalentHitKind.Row) continue;
      if (seen[seen.length - 1] !== hit.index) seen.push(hit.index);
    }
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  it('answers the × in the header and nothing else up there', () => {
    const rect = roomyRect();
    const rows = talentPanelRows(view());
    const hits: number[] = [];
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      if (talentPanelHitAt(rect, rows, x, rect.y + 6)?.kind === TalentHitKind.Close) hits.push(x);
    }
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[hits.length - 1] ?? 0).toBe((hits[0] ?? 0) + hits.length - 1);
    expect(hits[0]).toBeGreaterThan(rect.x + Math.floor((rect.w * 3) / 4));
  });

  it('offers no `+` at all when the hand is empty, so nothing looks pressable', () => {
    const rect = roomyRect();
    const rows = talentPanelRows(view({ progress: progressFrame({ unspent: 0 }) }));
    for (const placed of talentPanelGeometry(rect, rows).placed) {
      expect(placed.plus).toBeNull();
    }
    // ...and a full sweep of the panel finds no Spend anywhere on it.
    let spends = 0;
    for (let y = rect.y; y < rect.y + rect.h; y += 2) {
      for (let x = rect.x; x < rect.x + rect.w; x += 2) {
        if (talentPanelHitAt(rect, rows, x, y)?.kind === TalentHitKind.Spend) spends += 1;
      }
    }
    expect(spends).toBe(0);
  });

  it('offers no `+` on a capped talent while offering one on its neighbour', () => {
    const rect = roomyRect();
    const mixed = [
      talent({ id: 'a', name: 'Capped', level: TALENT_MAX_LEVEL, descNext: null }),
      talent({ id: 'b', name: 'Room', level: 2 }),
    ];
    const rows = talentPanelRows(view({ loadout: mixed }));
    const placed = talentPanelGeometry(rect, rows).placed.flatMap((entry) =>
      entry.row.kind === TalentRowKind.Talent ? [entry] : [],
    );
    expect(placed[0]?.plus).toBeNull();
    expect(placed[1]?.plus).not.toBeNull();
  });

  it('answers null on the panel but off every control, which the caller swallows', () => {
    const rect = roomyRect();
    const rows = talentPanelRows(view());
    // The header strip, left of the ×.
    expect(talentPanelHitAt(rect, rows, rect.x + 2, rect.y + 6)).toBeNull();
    // ...and off the panel entirely.
    expect(talentPanelHitAt(rect, rows, rect.x - 4, rect.y - 4)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE DROP POLICY — no scrolling, and it says so in words
// ---------------------------------------------------------------------------

describe('the drop policy', () => {
  it('drops the tail and says how many went, rather than silently truncating', () => {
    // ui/caselog.ts:467-478's rule: a surface that has quietly stopped showing
    // everything must never make the reader infer it.
    const rect = { x: 0, y: 0, w: 300, h: 110 };
    const rows = talentPanelRows(view());
    const placed = talentPanelGeometry(rect, rows).placed;
    const shown = placed.filter((entry) => entry.row.kind === TalentRowKind.Talent);
    expect(shown.length).toBeLessThan(4);

    const last = placed[placed.length - 1];
    expect(last?.row.kind).toBe(TalentRowKind.Note);
    if (last?.row.kind !== TalentRowKind.Note) throw new Error('unreachable');
    expect(last.row.text).toContain('hidden');
  });

  it('does not reserve the note’s line when nothing is going to be dropped', () => {
    // The fourth talent is exactly what the drop policy exists to protect, and a
    // per-row lookahead would have dropped it to make room for a message saying
    // it had been dropped.
    const rect = roomyRect();
    const placed = talentPanelGeometry(rect, talentPanelRows(view())).placed;
    expect(placed.filter((entry) => entry.row.kind === TalentRowKind.Talent)).toHaveLength(4);
    expect(placed.some((entry) => entry.row.kind === TalentRowKind.Note)).toBe(false);
  });

  it('never places a row below the panel’s own inner bottom', () => {
    for (const h of [80, 110, 150, 200, 252]) {
      const rect = { x: 0, y: 0, w: 300, h };
      for (const placed of talentPanelGeometry(rect, talentPanelRows(view())).placed) {
        expect(placed.rect.y + placed.rect.h, `h=${h}`).toBeLessThanOrEqual(rect.y + rect.h);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// PAINTING — the diff, and that the drawer is wired to the geometry
// ---------------------------------------------------------------------------

describe('drawing', () => {
  /**
   * The Proxy recorder from test/client/classpicker.test.ts:218-238, with one
   * addition: `fillText`'s STRING is kept, not just the call's arity. The
   * current->next diff is the single most valuable thing on this panel — it is
   * what proves a talent level is not a lie — so the test has to be able to see
   * which sentences were drawn.
   *
   * `measureText` answers SIX PIXELS PER CHARACTER rather than the flat constant
   * the other panel tests use, and that is load-bearing here: a constant width
   * makes `fitText` truncate every string it is given — including a two-character
   * button label — so the recorded text would be an ellipsis and the diff could
   * not be read at all. Six is the advance of the 10px monospace every panel in
   * this client draws with.
   */
  function recorder(
    clips: { x: number; y: number; w: number; h: number }[],
    calls: string[],
    texts: string[],
  ) {
    return new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (prop === 'measureText') return (text: string) => ({ width: text.length * 6 });
          if (prop === 'rect')
            return (x: number, y: number, w: number, h: number) => {
              clips.push({ x, y, w, h });
            };
          if (prop === 'fillText')
            return (text: string, ...rest: unknown[]) => {
              texts.push(text);
              calls.push(`fillText(${rest.length + 1})`);
            };
          if (prop === 'canvas') return undefined;
          return (...args: unknown[]) => {
            calls.push(`${prop}(${args.length})`);
          };
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
  }

  function paint(panelView: TalentPanelView, armedId: string | null = null) {
    const clips: { x: number; y: number; w: number; h: number }[] = [];
    const calls: string[] = [];
    const texts: string[] = [];
    const rect = roomyRect();
    drawTalentPanel({
      ctx: recorder(clips, calls, texts),
      // NO ART AT ALL, which is the honest state of the ability icons today:
      // `icon_active_*` is under no prefix in main.ts's NEEDED_ASSET_PREFIXES,
      // so the letter-plate fallback is the ONLY path and it runs here.
      sprites: { sprite: () => undefined },
      rect,
      rows: talentPanelRows(panelView),
      hoveredClose: false,
      hovered: null,
      armedId,
    });
    return { clips, calls, texts, rect };
  }

  it('clips to its own rect and pairs every save with a restore', () => {
    const { clips, calls, rect } = paint(view());
    expect(calls.length).toBeGreaterThan(0);
    expect(clips[0]).toEqual({ x: rect.x, y: rect.y, w: rect.w, h: rect.h });
    // An unbalanced restore leaks a font, an alignment or an alpha into every
    // painter later in the frame, and it presents as a bug in whichever surface
    // happens to be drawn next (ui/turncards.ts:786-790 records the same trap).
    expect(calls.filter((c) => c.startsWith('save(')).length).toBe(
      calls.filter((c) => c.startsWith('restore(')).length,
    );
  });

  it('draws BOTH halves of the current→next diff, with an arrow on the second', () => {
    // LevelupDialog.lua:963-970 renders the description twice — once at the
    // current level, once with +1 — and shows the two together. Without the pair
    // a level is a number with no consequence attached, which is the trap this
    // whole panel exists to avoid.
    const { texts } = paint(view());
    expect(texts).toContain('Hits for 12.');
    expect(texts.some((t) => t.includes('→') && t.includes('Hits for 15.'))).toBe(true);
  });

  it('draws only `desc` and NO arrow for a talent at its cap', () => {
    // LevelupDialog.lua:971-975 is the at-cap branch and it renders the current
    // description alone. `descNext: null` is that branch on the wire.
    const capped = [
      talent({
        id: 'a',
        name: 'Capped',
        level: TALENT_MAX_LEVEL,
        desc: 'Hits for 24.',
        descNext: null,
      }),
    ];
    const { texts } = paint(view({ loadout: capped }));
    expect(texts).toContain('Hits for 24.');
    expect(texts.some((t) => t.includes('→'))).toBe(false);
  });

  it('marks a capped talent with a WORD as well as a colour', () => {
    // ui/partypanel.ts:78-92: never colour alone. A capped talent and a talent
    // nobody can afford both lack a `+`, so the cap needs its own glyph.
    const capped = [talent({ id: 'a', name: 'Capped', level: TALENT_MAX_LEVEL, descNext: null })];
    const { texts } = paint(view({ loadout: capped }));
    expect(texts).toContain('MAX');
    expect(texts).toContain(`${TALENT_MAX_LEVEL}/${TALENT_MAX_LEVEL}`);
  });

  it('draws the `n/max` under every icon, which is what the points are counted in', () => {
    // TalentTrees.lua:429-433 centres the status string under the frame;
    // LevelupDialog.lua:952 sources it from getTalentLevelRaw, not the effective
    // level, because the panel spends POINTS.
    const { texts } = paint(view());
    for (const t of LOADOUT) expect(texts).toContain(`${t.level}/${t.maxLevel}`);
  });

  it('says the spend is permanent, and only while a row is armed', () => {
    const quiet = paint(view());
    expect(quiet.texts.some((t) => t.includes('no refund'))).toBe(false);

    const armed = paint(view(), 'talent:fog_step');
    expect(armed.texts.some((t) => t.includes('no refund'))).toBe(true);
    // ...and the armed control wears a different GLYPH, not merely a different
    // colour: `+?` rather than `+`.
    expect(armed.texts).toContain('+?');
    expect(quiet.texts).toContain('+');
  });

  it('paints the badge only when there is a point in hand, and counts it', () => {
    expect(paint(view()).texts.some((t) => t.includes('2 points to spend'))).toBe(true);
    expect(paint(view({ progress: progressFrame({ unspent: 1 }) })).texts).toContain(
      '1 point to spend',
    );
    const none = paint(view({ progress: progressFrame({ unspent: 0 }) }));
    expect(none.texts.some((t) => t.includes('to spend'))).toBe(false);
  });

  it('still paints, and still clips, in a panel too small for four rows', () => {
    const clips: { x: number; y: number; w: number; h: number }[] = [];
    const calls: string[] = [];
    const texts: string[] = [];
    const rect = { x: 4, y: 4, w: 190, h: 96 };
    drawTalentPanel({
      ctx: recorder(clips, calls, texts),
      sprites: { sprite: () => undefined },
      rect,
      rows: talentPanelRows(view()),
      hoveredClose: true,
      hovered: 0,
      armedId: null,
    });
    expect(clips[0]).toEqual(rect);
    expect(texts.some((t) => t.includes('hidden'))).toBe(true);
  });
});
