/// <reference lib="dom" />

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/dialogs/ShowChatLog.lua:46-55 (the
// tab row) and game/engines/default/engine/LogDisplay.lua (the stream).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { LogTab, createCaseLog } from '../../src/client/ui/caselog.ts';
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
