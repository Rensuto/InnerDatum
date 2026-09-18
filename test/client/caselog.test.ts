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
  LOG_TABS,
  LogTab,
  createCaseLog,
  logCogAt,
  logCogRect,
  logDragAt,
  logComposerRect,
  logGripRect,
  snapStyle,
  stampText,
} from '../../src/client/ui/caselog.ts';
import { HEADER_H, panelInner } from '../../src/client/ui/panel.ts';
import { PANEL_MIN_H, PANEL_MIN_W } from '../../src/client/ui/drag.ts';
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

/**
 * A CANVAS THAT REMEMBERS WHAT IT WAS ASKED TO PRINT, and measures a fixed
 * advance per character so `fitText` behaves. `the turn rule` below has a
 * richer one that also records x and font; this is the same idea with only the
 * text kept, which is all a label assertion needs.
 */
function painter() {
  const printed: unknown[][] = [];
  const state: Record<string, unknown> = { font: '10px monospace' };
  const ctx = new Proxy(state, {
    get: (target, prop: string) => {
      if (prop === 'measureText') return (text: string) => ({ width: [...text].length * 6 });
      if (prop === 'fillText')
        return (...args: unknown[]) => {
          printed.push(args);
        };
      if (prop in target) return target[prop];
      return () => undefined;
    },
    set: (target, prop: string, value: unknown) => {
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, printed };
}

const SPRITES = { sprite: () => undefined };
const DRAW_RECT = { x: 40, y: 60, w: 420, h: 220 };

/** A log with no canvas — nothing here draws; `draw` is covered by the painter. */
function log() {
  let changes = 0;
  const it = createCaseLog({
    onChange: () => {
      changes += 1;
    },
  });
  const { ctx, printed } = painter();
  return {
    it,
    changes: () => changes,
    ctx,
    calls: (name: string) => (name === 'fillText' ? printed : []),
  };
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

    it.selectTab(LogTab.Events);
    expect(depth(it), 'the EVENTS tab is not filtering').toBe(2);

    it.selectTab(LogTab.People);
    expect(depth(it), 'the PEOPLE tab is not filtering').toBe(1);
  });

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE BUTTON MOVED AND THE WIRE DID NOT. `LogTab`'s key is what a player
   * reads; its VALUE is `LogLane`.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * *"Case Log should just be called Log, we need to change the naming
   * convention for Record and Margin in the log UI to accomodate the change."*
   * Record became EVENTS and Margin became PEOPLE.
   *
   * `visible()` filters by `line.lane === tab`, so each value IS the wire
   * literal. Renaming one would be a protocol bump for a word nobody sees, and
   * the ruling is that ids stay stable while what players read changes. This is
   * that split asserted from both sides: the labels are the new words, and the
   * values are still the old ones.
   */
  it('renames the buttons without touching the wire literals', () => {
    expect(LogTab.Events).toBe(LogLane.Record);
    expect(LogTab.People).toBe(LogLane.Margin);
    expect(LOG_TABS).toEqual(['all', 'record', 'margin']);
  });

  it('draws the three tabs as ALL / EVENTS / PEOPLE', () => {
    const { it, ctx, calls } = log();
    it.draw({ ctx, sprites: SPRITES, rect: DRAW_RECT, gameTurn: 4 });
    const printed = calls('fillText').map((c) => String(c[0]));
    expect(printed, 'the ALL tab lost its label').toContain('ALL');
    expect(printed, 'RECORD did not become EVENTS').toContain('EVENTS');
    expect(printed, 'MARGIN did not become PEOPLE').toContain('PEOPLE');
    // AND THE OLD WORDS ARE GONE FROM THE SURFACE, which is the half a
    // rename usually leaves behind.
    expect(printed).not.toContain('RECORD');
    expect(printed).not.toContain('MARGIN');
  });

  it('titles the panel LOG, and keeps the turn on it', () => {
    // *"Case Log should just be called Log"*. The turn stays: it is the one
    // fact on this header that changes, and the scrollback is read against it.
    const { it, ctx, calls } = log();
    it.draw({ ctx, sprites: SPRITES, rect: DRAW_RECT, gameTurn: 12 });
    const printed = calls('fillText').map((c) => String(c[0]));
    expect(printed).toContain('LOG · turn 12');
    for (const text of printed) {
      expect(text, `the header still says CASE LOG: ${text}`).not.toContain('CASE LOG');
    }
  });

  it('says LOG alone before the first turn has landed', () => {
    const { it, ctx, calls } = log();
    it.draw({ ctx, sprites: SPRITES, rect: DRAW_RECT, gameTurn: -1 });
    expect(calls('fillText').map((c) => String(c[0]))).toContain('LOG');
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
    it.selectTab(LogTab.Events);
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
 * THE TURN RULE STAYS INSIDE THE PANEL — through `draw`, not the source.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reported as *"the chat box ui overlaps outside the bounds no matter what
 * size, you can see the lines on the right extending out"*. The lines were the
 * `── turn N ───` rules. The timestamp column moved every row right by its own
 * width and took that width off the text's wrap width — the two strings the
 * test above pins — but the rule is a THIRD site, and it was still counted to
 * the whole band. So it hung past the border by the width of the column, which
 * is a number the font sets and the panel never does. That is why resizing
 * could not help.
 *
 * WHY NEITHER EXISTING SHAPE OF TEST COULD SEE IT. A source-text assertion only
 * finds the sites somebody thought to list. And a draw through
 * `canvasstub.ts` measures every string as 0 wide, which makes `turnRule` give
 * back the heading with no dashes at all — there is nothing left to overhang.
 *
 * So this recorder measures a FIXED ADVANCE PER CHARACTER, SCALED BY THE SIZE
 * IN THE CURRENT `ctx.font` — six at 10px, the convention the other painters'
 * tests use. The scaling is what makes the cogwheel's font step a real axis
 * here: it widens the stamp column the way it does live, and the overhang with
 * it. Rounded to whole pixels so an exact fit is exact and not a float.
 */
describe('the turn rule', () => {
  type Drawn = { readonly text: string; readonly x: number; readonly font: string };

  const advance = (font: string): number => {
    const px = /(\d+)px/.exec(font)?.[1];
    return Math.round((px === undefined ? 10 : Number(px)) * 0.6);
  };
  const widthOf = (text: string, font: string): number => [...text].length * advance(font);

  function recorder(drawn: Drawn[]) {
    const state: Record<string, unknown> = { font: '' };
    return new Proxy(state, {
      get: (target, prop: string) => {
        if (prop === 'measureText')
          return (text: string) => ({ width: widthOf(text, String(target.font)) });
        if (prop === 'fillText')
          return (text: string, x: number) => {
            drawn.push({ text, x, font: String(target.font) });
          };
        if (prop in target) return target[prop];
        return () => undefined;
      },
      set: (target, prop: string, value: unknown) => {
        target[prop] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
  }

  /** The resize floor, a wide panel, and 533 — the width in the report's screenshot. */
  const WIDTHS = [PANEL_MIN_W, 240, 400, 533, 800] as const;
  /** The cogwheel's Small, Normal and Big. */
  const FONTS = [9, 10, 13] as const;

  it('ends at the content edge at every width and every font step, and never past it', () => {
    /**
     * EVERY CELL OF THE MATRIX IS CHECKED BEFORE ANYTHING FAILS. The report
     * was "no matter what size", and a test that stopped at the first width
     * would say one size is broken. The list it prints is the claim.
     */
    const wrong: string[] = [];
    let rulesDrawn = 0;
    for (const font of FONTS) {
      for (const w of WIDTHS) {
        const it = createCaseLog({ onChange: () => undefined });
        it.setStyle({ ...DEFAULT_LOG_STYLE, font });
        // Three turns, so two rules — and a long line, so ordinary rows wrap
        // and are held to the same border in the same pass.
        it.append([
          line({ seq: 1, gameTurn: 9, text: 'you wake in the cave' }),
          line({ seq: 2, gameTurn: 10, text: 'the rat bites you for 3 physical damage' }),
          line({
            seq: 3,
            gameTurn: 11,
            text: 'the warden raises a lantern and the light finds every corner of the room at once',
          }),
        ]);

        // TALL ENOUGH THAT BOTH RULES ARE ON SCREEN at the Big font on the
        // narrowest panel, where the long line wraps down most of the band. At
        // 240 tall the older rule was scrolled off the top rather than drawn.
        const drawn: Drawn[] = [];
        const rect = { x: 20, y: 300, w, h: 320 };
        it.draw({ ctx: recorder(drawn), sprites: { sprite: () => undefined }, rect, gameTurn: 11 });

        const where = `w=${String(w)} font=${String(font)}`;
        const border = rect.x + rect.w;
        for (const each of drawn) {
          const end = each.x + widthOf(each.text, each.font);
          if (end > border) {
            wrong.push(
              `${where}: "${each.text.slice(0, 10)}…" ends at ${String(end)}, border ${String(border)}`,
            );
          }
        }

        const content = panelInner({
          x: rect.x,
          y: rect.y + HEADER_H,
          w: rect.w,
          h: rect.h - HEADER_H,
        });
        const edge = content.x + content.w;
        const rules = drawn.filter((each) => each.text.startsWith('── turn '));
        if (rules.length !== 2) wrong.push(`${where}: ${String(rules.length)} rules drawn, not 2`);
        rulesDrawn += rules.length;
        for (const rule of rules) {
          const end = rule.x + widthOf(rule.text, rule.font);
          // Past the content edge is into the frame, even while still short of
          // the border.
          if (end > edge) {
            wrong.push(`${where}: a rule ends at ${String(end)}, content edge ${String(edge)}`);
          }
          // AND IT STILL REACHES IT. `turnRule` floors its dash count, so a rule
          // counted to the column it is drawn in ends within one dash of the
          // edge. A "fix" that cut every rule to its heading, or counted to half
          // the band, would clear both bounds above and fail this one.
          if (end <= edge - widthOf('─', rule.font)) {
            wrong.push(
              `${where}: a rule stops at ${String(end)}, short of the edge ${String(edge)}`,
            );
          }
        }
      }
    }
    expect(rulesDrawn, 'no rule was drawn, so nothing above was tested').toBeGreaterThan(0);
    expect(wrong).toEqual([]);
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

const logFixture = log;

describe('the composer strip', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE CHAT BOX MOVED INTO THE CASE LOG.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Asked for as *"the chat bar below it needs to be removed and added to the
   * 'case log' to active chat, we will not use the / or t button but instead
   * just the enter key to active and escape key to close it"*.
   *
   * The field itself is still a real DOM `<input>` — index.html argues that at
   * length and none of it stopped being true — so what lives here is the BOX it
   * is positioned into, and the box has to be a pure function or the painter,
   * the hit test and the DOM placer would each have their own idea of where the
   * player is typing.
   */
  const RECT = { x: 10, y: 20, w: 400, h: 240 };

  it('sits at the foot, inside the panel', () => {
    const box = logComposerRect(RECT);
    expect(box, 'a panel this size has no composer').not.toBeNull();
    if (box === null) return;
    expect(box.y + box.h, 'the composer hangs out of the panel').toBeLessThanOrEqual(
      RECT.y + RECT.h,
    );
    expect(box.y, 'the composer is not at the foot').toBeGreaterThan(RECT.y + RECT.h / 2);
    expect(box.x, 'the composer starts outside the panel').toBeGreaterThanOrEqual(RECT.x);
  });

  it('stops short of the resize grip, or the log can never be resized again', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A DOM ELEMENT CANNOT BE HIT-TESTED THROUGH.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The `<input>` is positioned over this box and it is opaque to the
     * pointer. `logGripRect` is the bottom-right `LOG_GRIP_PX` square of the
     * same panel, so a full-width composer would sit exactly on top of the grip
     * — and the canvas `mousedown` that begins a resize would never fire again.
     * Not a visual overlap: a control that has stopped existing.
     */
    const box = logComposerRect(RECT);
    const grip = logGripRect(RECT);
    expect(box).not.toBeNull();
    if (box === null) return;
    expect(box.x + box.w, 'the composer covers the resize grip').toBeLessThanOrEqual(grip.x);
  });

  it('refuses to exist rather than eat the last line of transcript', () => {
    // A panel at its floor cannot hold a header, a tab row, a composer AND a
    // line of log. The transcript wins: a log you cannot read is worse than one
    // you cannot type into, and the box can always be made bigger.
    expect(logComposerRect({ x: 0, y: 0, w: 400, h: PANEL_MIN_H })).toBeNull();
  });

  it('answers no press before anything has been drawn', () => {
    // Same contract as `tabAt` and `bodyAt`: a widget that claimed a click it
    // had never painted for would swallow presses meant for the map.
    const { it: log } = logFixture();
    expect(log.composerAt(15, 250)).toBe(false);
    expect(log.composerBox()).toBeNull();
  });
});

describe('Enter talks, and the numpad still commits', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE COLLISION THIS PAIR EXISTS TO KEEP FIXED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `say` ships on `key:enter`. `commit` FREEZES `code:NumpadEnter` so "the
   * numpad hand can always end a turn without leaving the pad" — and a numpad
   * press reports `event.key === 'Enter'`. The dispatcher used to consult the
   * key-keyed UI table before the code-keyed command table, so the moment Enter
   * learned to talk, the frozen binding was silently stolen: a numpad press
   * opened the chat box, and the Keys screen went on reporting it as bound
   * because `BASELINE` is computed from the defaults rather than from what the
   * dispatcher can reach.
   *
   * The order is code-then-key now, which is what `resolveAction`'s own order
   * sentence has said all along and what the `dir` and `slot` lookups already
   * did.
   */
  it('reads the code-keyed commands before the key-keyed verbs', () => {
    const source = readFileSync('src/client/input/keys.ts', 'utf8');
    const byCode = source.indexOf('const byCode = keymap.commandByCode.get(event.code);');
    const ui = source.indexOf('const ui = keymap.uiByKey.get(lower);');
    expect(byCode, 'the code-keyed command lookup is gone').toBeGreaterThan(-1);
    expect(ui).toBeGreaterThan(-1);
    expect(byCode, 'a verb on `enter` steals the frozen NumpadEnter commit').toBeLessThan(ui);
  });
});
