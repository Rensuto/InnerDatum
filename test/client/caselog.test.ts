/// <reference lib="dom" />

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/dialogs/ShowChatLog.lua:46-55 (the
// tab row) and game/engines/default/engine/LogDisplay.lua (the stream).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOG_STYLE,
  LogTab,
  createCaseLog,
  logCogAt,
  logCogRect,
  logDragAt,
  logGripRect,
  snapStyle,
  stampText,
} from '../../src/client/ui/caselog.ts';
import { HEADER_H } from '../../src/client/ui/panel.ts';
import { PANEL_MIN_H } from '../../src/client/ui/drag.ts';
import { DAMAGE_INK, PALETTE } from '../../src/client/render/canvas.ts';
import { DAMAGE_TYPES, DamageType } from '../../src/shared/damagetype.ts';
import { LogLane } from '../../src/shared/protocol.ts';
import type { LogLine } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE STREAM, IN ARRIVAL ORDER, AND THAT ORDER IS THE WHOLE RISK.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The log was two capped arrays, one per lane. Merging them means the entries
 * have to come back out in the order they happened — and the obvious key does
 * not work: `seq` is the server's monotonic counter, but a client-authored line
 * (a refusal, the combat crossing) carries `seq = 0` because the client may not
 * mint one. Sorting by `seq` puts every one of those at the very top of the log,
 * oldest-first, which is exactly wrong and would look like corruption.
 *
 * So the buffer IS the order. These tests are what stop somebody "fixing" it
 * into a sort later.
 */
function line(over: Partial<LogLine> & { readonly text: string }): LogLine {
  return {
    seq: 0,
    lane: LogLane.Record,
    gameTurn: 1,
    ...over,
  };
}

/** A log with no canvas — nothing here draws; `draw` is covered by the painter. */
function log() {
  let changes = 0;
  const it = createCaseLog({
    onChange: () => {
      changes += 1;
    },
  });
  return { it, changes: () => changes };
}

/**
 * HOW MANY ENTRIES THE ACTIVE TAB IS SHOWING, measured through the only reader
 * the widget exposes.
 *
 * `scroll` clamps, so asking it to move a large number and checking it returned
 * true tells you almost nothing — it succeeds at any length above one. Stepping
 * ONE at a time until it refuses counts the list exactly, and that precision is
 * the point: the first version of these tests passed against both two entries
 * and three, which made a real mutation (a local line swallowed by the
 * high-water mark) invisible.
 */
function depth(it: ReturnType<typeof createCaseLog>): number {
  it.toBottom();
  let n = 1;
  while (it.scroll(1)) n += 1;
  it.toBottom();
  return n;
}

describe('the merged stream', () => {
  it('keeps arrival order across lanes, not seq order', () => {
    const { it } = log();
    // A server Record line, then a CLIENT line (seq 0), then another server one.
    it.append([line({ seq: 1, text: 'you hit it' })]);
    it.note({ lane: LogLane.Margin, gameTurn: 1, text: 'get to me' });
    it.append([line({ seq: 2, text: 'it hits you' })]);

    // There is no reader for the buffer, so this counts through the scroll
    // range — which is the visible list, one entry at a time.
    expect(depth(it), 'a line was dropped or duplicated on the way in').toBe(3);
  });

  it('de-duplicates a resync by seq, and never swallows a local line', () => {
    /**
     * `append` rejects anything at or below the high-water mark, which is how a
     * resent tail costs nothing. A local line carries `seq = 0` and must NOT be
     * measured against that mark — it would be swallowed by the first server
     * line ever received, and every refusal after it would vanish.
     */
    const { it } = log();
    it.append([line({ seq: 1, text: 'one' }), line({ seq: 2, text: 'two' })]);
    it.append([line({ seq: 1, text: 'one' }), line({ seq: 2, text: 'two' })]);
    expect(depth(it), 'the resend was not de-duplicated').toBe(2);

    it.note({ lane: LogLane.Margin, gameTurn: 1, text: 'local' });
    expect(depth(it), 'a seq-0 line was swallowed by the high-water mark').toBe(3);
  });
});

describe('the tabs', () => {
  it('opens on ALL', () => {
    expect(log().it.activeTab()).toBe(LogTab.All);
  });

  it('filters the stream to one lane, and ALL shows both', () => {
    const { it } = log();
    it.append([
      line({ seq: 1, text: 'record one' }),
      line({ seq: 2, text: 'record two' }),
      line({ seq: 3, lane: LogLane.Margin, text: 'said something' }),
    ]);

    expect(depth(it), 'ALL is not showing all three').toBe(3);

    it.selectTab(LogTab.Record);
    expect(depth(it), 'the RECORD tab is not filtering').toBe(2);

    it.selectTab(LogTab.Margin);
    expect(depth(it), 'the MARGIN tab is not filtering').toBe(1);
  });

  it('goes to the bottom when the tab changes', () => {
    /**
     * The offset counts entries back from the newest of the FILTERED list, so
     * the same number means a different place in each tab. Carrying it across
     * would drop the reader somewhere arbitrary.
     */
    const { it } = log();
    it.append([
      line({ seq: 1, text: 'a' }),
      line({ seq: 2, text: 'b' }),
      line({ seq: 3, text: 'c' }),
    ]);
    it.scroll(2);
    it.selectTab(LogTab.Record);
    // At the bottom, so scrolling FORWARD does nothing.
    expect(it.scroll(-1), 'the tab change did not reset the view').toBe(false);
  });

  it('reports no change when the same tab is chosen again', () => {
    const { it, changes } = log();
    const before = changes();
    expect(it.selectTab(LogTab.All)).toBe(false);
    expect(changes(), 'a no-op tab press asked for a redraw').toBe(before);
  });

  it('answers no tab and no body before anything has been drawn', () => {
    /**
     * Both hit tests read rects captured by the LAST draw. Before one there are
     * none, and a widget that claimed a click it had never painted for would
     * swallow presses meant for the map underneath.
     */
    const { it } = log();
    expect(it.tabAt(10, 10)).toBeNull();
    expect(it.bodyAt(10, 10)).toBe(false);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ELEMENT COLOURS THE LINE — and the field crosses two hops to get here.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `LogLine.damage` is composed in the gateway's `recordFor`, returned through a
 * type that has to name it, and copied into the wire object by an emit loop
 * that builds the line FIELD BY FIELD. A field added to one and not the other
 * is dropped silently — the shape this codebase has been bitten by twice
 * (`Blow` losing `type`, `hitToWire` losing `crit`).
 *
 * The widget half is here; the server half is asserted against the source,
 * because the gateway is not importable from a client test.
 */
describe('the element colour', () => {
  it('has one ink for every damage type this game has, and no gaps', () => {
    /**
     * SIX, and the table is total over them so the compiler names every site
     * the day a seventh arrives. There is no poison and no green — "fill the
     * gaps" is a closed set here, which is why this counts rather than spot-
     * checking.
     */
    expect(DAMAGE_TYPES.length).toBe(6);
    for (const type of DAMAGE_TYPES) {
      expect(DAMAGE_INK[type], `${type} has no ink`).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('gives the four elements upstream tints their own colour, all distinct', () => {
    /**
     * Physical is upstream's `#WHITE#`, which in a ToME log is the UNTINTED
     * default — so it shares the ordinary ink here rather than being a seventh
     * colour. The other five must differ from each other, or the whole point
     * (tell at a glance which of six hit you) is lost.
     */
    expect(DAMAGE_INK[DamageType.Physical]).toBe(PALETTE.PARCHMENT);
    const tinted = [
      DamageType.Fire,
      DamageType.Cold,
      DamageType.Lightning,
      DamageType.Darkness,
      DamageType.Mind,
    ].map((type) => DAMAGE_INK[type]);
    expect(new Set(tinted).size, 'two elements share an ink').toBe(tinted.length);
  });

  it('carries the field from the sentence to the wire, through BOTH hops', () => {
    const source = readFileSync('src/server/net/gateway.ts', 'utf8');
    // The seam's return type names it...
    expect(source, "recordFor's return type dropped the element").toContain(
      'depth: number; damage?: DamageType',
    );
    // ...and the emit loop copies it onto the line that actually reaches the
    // wire. Either one alone is the silent-drop bug.
    expect(source, 'the emit loop builds the LogLine without the element').toContain(
      '...(line.damage === undefined ? {} : { damage: line.damage })',
    );
    // ABSENT STAYS ABSENT. A heal returns from the same arm with no type, and
    // `?? 'physical'` anywhere here would paint every heal as a blow.
    expect(source).toContain('...(event.type === undefined ? {} : { damage: event.type })');
  });

  it('leaves an untyped line alone and never repaints a person', () => {
    const painter = readFileSync('src/client/ui/caselog.ts', 'utf8');
    // The Margin wins outright — a person's words are violet because of WHO
    // said them, and an element must not repaint that.
    expect(painter).toContain('rowMargin\n        ? PALETTE.VIOLET_HI');
    // And no element means the ordinary ink, not a default one.
    expect(painter).toContain('? PALETTE.PARCHMENT');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TIMESTAMPS — and the clock is the CLIENT'S, which is the whole design.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There is no wall-clock anywhere on the wire, deliberately twice over:
 * `src/shared/` is pure and cannot call `Date.now()`, and two protocol
 * docblocks refuse absolute time because "the client's clock is not the
 * server's". And `gameTurn` cannot stand in — it is a COMPLETED-TURN COUNTER,
 * so an eight-line area attack stamps eight lines with one value and a
 * client-authored line carries -1.
 *
 * So the stamp is when the line ARRIVED HERE, which is what a chat timestamp
 * means anywhere else.
 */
describe('timestamps', () => {
  it('renders HH:MM, zero-padded, in the viewer’s own timezone', () => {
    const at = new Date(2026, 8, 8, 9, 7, 45).getTime();
    expect(stampText(at)).toBe('09:07');
    const noon = new Date(2026, 8, 8, 14, 30, 0).getTime();
    expect(stampText(noon)).toBe('14:30');
  });

  it('is always the same width, so the text column cannot step sideways', () => {
    /**
     * The gutter is measured once from a sample rather than per line. A stamp
     * that changed width at 09:59 -> 10:00 would move every line's left edge on
     * the hour.
     */
    const widths = new Set(
      [
        new Date(2026, 0, 1, 0, 0).getTime(),
        new Date(2026, 0, 1, 9, 9).getTime(),
        new Date(2026, 0, 1, 23, 59).getTime(),
      ].map((at) => stampText(at).length),
    );
    expect(widths.size, 'the stamp is not a fixed width').toBe(1);
  });

  it('stamps the first row of every entry, not only the ones with a speaker', () => {
    /**
     * `lead` already existed and means "first row of an entry that HAS a
     * speaker" — it is there for the bold `Sam:` prefix. Reusing it for the
     * stamp would have timestamped conversation and nothing else, which is the
     * mistake this assertion exists to keep fixed.
     */
    const painter = readFileSync('src/client/ui/caselog.ts', 'utf8');
    expect(painter).toContain('first: r === 0,');
    expect(painter, 'the stamp rides `lead`, so only spoken lines get one').toContain(
      'if (row.line !== null && row.first) {',
    );
  });

  it('takes its gutter out of the wrap width rather than painting over the text', () => {
    // Wrapping to the full width and then drawing a stamp on top is how a
    // column ends up sitting on the first word of every line.
    const painter = readFileSync('src/client/ui/caselog.ts', 'utf8');
    expect(painter).toContain('rect.w - stampW - indent - boldDebt');
    expect(painter).toContain('const x = rect.x + stampW + row.indent;');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE COGWHEEL — and the pixels it had to take off the drag handle.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Asked for as *"an opacy setting (make cogwheel settings button for chat box
 * for font fize, opacy, spacing, etc) button on the case log pane at the top
 * right of the pane"*.
 *
 * Upstream's shape for the font half is `GameOptions.lua:205-211`: a THREE-ITEM
 * list popup — Small, Normal, Big — not a slider. Ours is per-panel and live
 * where upstream's is global and says "You must restart the game".
 */
describe('the cogwheel', () => {
  const RECT = { x: 100, y: 200, w: 400, h: 180 };

  it('sits in the header’s top right, inside the panel', () => {
    const cog = logCogRect(RECT);
    expect(cog.x + cog.w, 'the cog overhangs the panel').toBeLessThanOrEqual(RECT.x + RECT.w);
    expect(cog.x, 'the cog is not in the RIGHT end').toBeGreaterThan(RECT.x + RECT.w / 2);
    expect(cog.y, 'the cog rode up out of the header').toBeGreaterThanOrEqual(RECT.y);
    expect(cog.y + cog.h, 'the cog spilled out of the header into the body').toBeLessThanOrEqual(
      RECT.y + HEADER_H,
    );
  });

  it('is not part of the drag handle — the bug that would otherwise ship', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * WHAT IT COSTS WITHOUT THIS.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `logDragAt` claimed the header's FULL width and deliberately did not use
     * `headerDragRect` — there was nothing in the strip to carve out. The
     * cogwheel is the first thing there, and a handle that still claimed those
     * pixels would start a panel drag on the press, move the log under the
     * pointer, and only then open the menu. `ui/panel.ts` carries the same note
     * for the three panels that reserve their close control.
     */
    const cog = logCogRect(RECT);
    const mid = { x: cog.x + Math.floor(cog.w / 2), y: cog.y + Math.floor(cog.h / 2) };
    expect(logCogAt(RECT, mid.x, mid.y), 'the cog does not answer to its own centre').toBe(true);
    expect(logDragAt(RECT, mid.x, mid.y), 'the drag handle still owns the cogwheel').toBe(false);
    // And the rest of the strip still drags, or the panel cannot be moved.
    expect(logDragAt(RECT, RECT.x + 20, RECT.y + 5), 'the header stopped being a handle').toBe(
      true,
    );
  });

  it('does not collide with the resize grip', () => {
    // One is top-right, the other bottom-right; on a short panel a careless
    // vertical could put them on the same pixels.
    const short = { x: 0, y: 0, w: 200, h: PANEL_MIN_H };
    const cog = logCogRect(short);
    const grip = logGripRect(short);
    expect(cog.y + cog.h, 'the cogwheel reaches the grip').toBeLessThanOrEqual(grip.y);
  });
});

describe('the three settings', () => {
  it('offers ToME’s three font steps, not a slider', () => {
    /**
     * `GameOptions.lua:208` lists exactly Normal, Small and Big. Three named
     * answers reached in one press is the property worth porting — a slider on
     * a canvas would be a third drag gesture on a panel that already has two.
     */
    const source = readFileSync('src/client/ui/caselog.ts', 'utf8');
    expect(source).toContain('const FONT_STEPS = [9, 10, 13] as const;');
    expect(source).toContain("names: ['Small', 'Normal', 'Big'],");
  });

  it('snaps an unreachable saved value to the nearest step it can draw', () => {
    /**
     * The wire carries VALUES, not indices into this build's step list — so a
     * save from a build with different steps has to land somewhere. Nearest,
     * not rejected: the same degrade-don't-fail the `offsets` record uses for a
     * panel the client no longer has.
     */
    expect(snapStyle({ font: 11, opacity: 73, spacing: 15 })).toEqual({
      font: 10,
      opacity: 80,
      spacing: 14,
    });
    // An exact step is left exactly alone.
    expect(snapStyle(DEFAULT_LOG_STYLE)).toEqual(DEFAULT_LOG_STYLE);
    // And something wild still comes back drawable rather than as NaN.
    const wild = snapStyle({ font: 999, opacity: -40, spacing: 0 });
    expect(wild.font).toBe(13);
    expect(wild.opacity).toBe(40);
    expect(wild.spacing).toBe(10);
  });

  it('spends the opacity on the frame and never on the text', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ONE-LINE VERSION OF THIS FEATURE IS THE USELESS ONE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Setting `globalAlpha` once for the whole panel is fewer lines and fades
     * the words with the backing — at 40% the player has traded a log they can
     * read for a log they can see through. What a transparent log window is FOR
     * is reading the words while seeing the map underneath, so the alpha is
     * restored to 1 the moment the frame is painted.
     */
    const source = readFileSync('src/client/ui/caselog.ts', 'utf8');
    const set = source.indexOf('ctx.globalAlpha = style.opacity / PERCENT;');
    const clear = source.indexOf('ctx.globalAlpha = 1;');
    expect(set, 'nothing applies the opacity').toBeGreaterThan(-1);
    expect(clear, 'the opacity is never restored — the text fades with it').toBeGreaterThan(set);
    // And it is restored BEFORE the rows are drawn, not merely somewhere later.
    expect(clear).toBeLessThan(source.indexOf('drawStream(ctx, visible(), {'));
  });

  it('keeps the chrome’s font off the size setting', () => {
    // FONT_META draws the header and the tab strip, both of fixed height.
    // Growing their text would not grow the boxes it sits in.
    const source = readFileSync('src/client/ui/caselog.ts', 'utf8');
    expect(source).toMatch(/const FONT_META = `bold 10px \$\{STACK\}`;/);
  });
});
