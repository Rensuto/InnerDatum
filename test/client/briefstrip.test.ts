/// <reference lib="dom" />

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { stubCanvas } from './canvasstub.ts';
import {
  BRIEF_STRIP_H,
  briefOnScreen,
  briefQuestRows,
  briefStripText,
  drawBriefStrip,
} from '../../src/client/ui/brief.ts';
import type { StubCtx } from './canvasstub.ts';
import type { BriefView } from '../../src/shared/protocol.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE STRIP — WHAT THIS PARTY TOOK ON, AND WHEN IT IS NOT DRAWN AT ALL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `vitest.config.ts` is deliberate that there is no jsdom and no canvas here, so
 * nothing below asserts a pixel. What it asserts is the handful of ways one line
 * of permanent furniture can be WRONG rather than ugly: drawn when there is
 * nothing to say, drawn for work that has already ended, or drawn somewhere a
 * panel has to fight it for the space.
 *
 * `canvasstub.ts` measures every string as zero wide, so the WIDTH of the pill
 * is not a claim this file can make. Its presence, its height and its top edge
 * are.
 */

const OPEN: BriefView = { state: 'open', title: 'It kept its name' };

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THE SAME FRAME, IN THE JOURNAL. ONE PLACE TO LOOK.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Journal's QUESTS section was written and shipped EMPTY, ahead of anything
 * that could fill it, to stop exactly the bug an objective with a surface of its
 * own would have: two places to check what a party agreed to, disagreeing the
 * first time either moved.
 */
describe('what the Journal reads off the same frame', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE JOIN, SCRAPED — BECAUSE `main.ts` IS NOT IMPORTABLE FROM A TEST.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Everything below this line is about `briefQuestRows` and every one of those
   * cases passes with the function called by nothing at all. The Journal's
   * QUESTS section would then render its empty state for ever, the launcher's
   * count would stay at the notes count, and the only symptom would be a
   * section that looked exactly as it did the day it shipped deliberately
   * empty.
   *
   * IT IS THE SAME SHAPE `escapemenu.test.ts` AND `fov.test.ts` BOTH USE for a
   * wiring that has no seam a test can hold: read the source and require the
   * two names to meet.
   *
   * MUTANT: delete the `quests:` line from `escapeMenuView`.
   */
  it('is wired into the Journal`s view, and not merely exported', () => {
    const main = readFileSync(new URL('../../src/client/main.ts', import.meta.url), 'utf8');
    expect(main, 'nothing imports the row builder').toContain('briefQuestRows');
    expect(main, 'the Journal is not built from the brief frame').toContain(
      'quests: briefQuestRows(briefView)',
    );
  });

  /**
   * `engine/Quest.lua:31-36` — upstream's four status words. `ui/escapemenu.ts`
   * says the status *"IS A WORD, ALREADY CHOSEN BY WHOEVER PRODUCES THE LIST"*
   * and leaves the reconciliation to the lane that ships the states.
   *
   * MUTANT: pass the server's own word straight through. The Journal then reads
   * `It kept its name — open`, which is a state name rather than a status a
   * player recognises, and it disagrees with every other quest log they know.
   */
  it('reconciles the server`s states with upstream`s status words', () => {
    expect(briefQuestRows({ state: 'open', title: 'It kept its name' })).toEqual([
      { id: 'brief', name: 'It kept its name', status: 'active' },
    ]);
    expect(briefQuestRows({ state: 'closed', title: 'It kept its name' })[0]?.status).toBe('done');
    expect(briefQuestRows({ state: 'failed', title: 'It kept its name' })[0]?.status).toBe(
      'failed',
    );
  });

  /**
   * AN OFFER NOBODY TOOK IS NOT SOMETHING THIS CHARACTER HAS AGREED TO DO, and
   * the server does not send one — so this is belt and braces on a state the
   * empty section's own sentence already excludes: *"work you take on is listed
   * here"*.
   *
   * MUTANT: list an offered objective. The Journal advertises work nobody
   * agreed to, which is the same lie the strip is forbidden from telling.
   */
  it('lists nothing at all for an offer, or for no frame', () => {
    expect(briefQuestRows(null)).toEqual([]);
    expect(briefQuestRows({ state: 'offered', title: 'It kept its name' })).toEqual([]);
  });

  /**
   * THE COUNT RIDES THE NAME, because this surface has two columns and the
   * status owns the second one.
   *
   * MUTANT: drop the progress. A counted objective reads the same on the first
   * body and on the last, in the one place a player goes to check.
   */
  it('carries the count in the name, where the row has room for it', () => {
    const row = briefQuestRows({ state: 'open', title: 'The sweep', progress: '1 / 3' })[0];
    expect(row?.name).toBe('The sweep · 1 / 3');
    expect(row?.status).toBe('active');
  });

  /**
   * AND IT IS THE SAME FRAME THE STRIP IS DRAWN FROM, which is the whole point.
   *
   * MUTANT: give the Journal its own source. The two surfaces then answer "what
   * am I doing?" from two places, which is the bug the empty section was
   * shipped early to prevent.
   */
  it('agrees with the strip about whether there is anything on hand', () => {
    for (const state of ['offered', 'open', 'closed', 'failed']) {
      const frame: BriefView = { state, title: 'It kept its name' };
      // The strip draws only an OPEN objective; the Journal keeps the outcome
      // for as long as the frame carries it, which is until the withdrawal.
      expect(briefOnScreen(frame)).toBe(state === 'open');
      expect(briefQuestRows(frame).length).toBe(state === 'offered' ? 0 : 1);
    }
  });
});

/**
 * The stub, cast at the boundary the way every other painter suite here does
 * it: the stub is a Proxy with no `CanvasRenderingContext2D` in sight, and the
 * cast is confined to these two lines rather than sprinkled through the cases.
 */
function ctxFor(): StubCtx {
  return stubCanvas(0, 0).getContext('2d') as StubCtx;
}

function paint(ctx: StubCtx, brief: BriefView | null, width: number, top: number): void {
  drawBriefStrip(ctx as never, brief, width, top);
}

describe('what the strip says', () => {
  it('reads the title alone when the objective has no count', () => {
    expect(briefStripText(OPEN)).toBe('It kept its name');
  });

  /**
   * MUTANT: drop the count. The strip then says the same thing on the first
   * body and on the last, which is the one moment the line has any news in it.
   */
  it('puts the count after the title, on one line', () => {
    expect(briefStripText({ ...OPEN, progress: '2 / 3' })).toBe('It kept its name · 2 / 3');
  });
});

describe('when the strip is on screen at all', () => {
  /**
   * WORK THAT HAS ENDED IS NOT WORK IN PROGRESS. The server sends the ending
   * state rather than falling silent, so the client can tell "it is over" from
   * "the frame never arrived" — and this is the line that acts on it.
   *
   * MUTANT: draw for any non-null frame. The band then sits over the map for
   * the rest of the floor saying the party is doing something they have already
   * finished or already lost.
   */
  it('is drawn for an open objective and for no other state', () => {
    expect(briefOnScreen(OPEN)).toBe(true);
    for (const state of ['offered', 'closed', 'failed']) {
      expect(briefOnScreen({ ...OPEN, state }), state).toBe(false);
    }
    expect(briefOnScreen(null)).toBe(false);
  });

  it('draws nothing whatsoever when there is nothing to say', () => {
    const ctx = ctxFor();
    paint(ctx, null, 800, 14);
    paint(ctx, { ...OPEN, state: 'failed' }, 800, 14);
    expect(ctx.rects, 'something was painted for a floor with no objective').toEqual([]);
  });

  /**
   * MUTANT: paint the pill full width, the way `drawLine` paints the notice.
   * That is right for a strip that is gone in four seconds and wrong for one
   * that is up for the length of a floor: at the top of the map it would sit
   * across the minimap's first rows the whole time.
   */
  it('draws one pill, sized to its words and centred, with its top edge where it was put', () => {
    const ctx = ctxFor();
    const width = 800;
    const top = 14;
    paint(ctx, OPEN, width, top);
    expect(ctx.rects).toHaveLength(1);
    const pill = ctx.rects[0];
    expect(pill?.y).toBe(top);
    expect(pill?.h).toBe(BRIEF_STRIP_H);
    expect(pill?.w, 'the pill reaches the edges of the playfield').toBeLessThan(width / 2);
    // CENTRED: the same margin on both sides, within the rounding.
    const left = pill?.x ?? 0;
    const right = width - left - (pill?.w ?? 0);
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AND THE WIRING IN main.ts, WHICH NO UNIT TEST CAN REACH.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The identical constraint `hudwiring.test.ts` states: main.ts calls `boot()`
 * at module load, which reaches for `document`, the Discord SDK and a
 * WebSocket, so the only way to assert where a line sits in that file is to
 * read it. Comments are stripped first for that file's stated reason — its
 * comments quote the code they justify, so a raw `includes` would pass against
 * a file whose line had been deleted and whose paragraph still described it.
 */
const CODE = readFileSync(new URL('../../src/client/main.ts', import.meta.url), 'utf8')
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
  .join('\n');

describe('the strip is wired into the HUD', () => {
  /**
   * MUTANT: leave `briefView` out of the `welcome` reset. A resume or a party
   * wipe then leaves the LAST floor's objective on screen until a frame
   * happens to land behind it — the exact bug the props line beside it was
   * written for.
   */
  it('clears the objective on the same reset that clears the shop and the props', () => {
    expect(CODE).toContain('briefView = null;');
    expect(CODE.indexOf('briefView = null;')).toBeGreaterThan(CODE.indexOf('shop = null;'));
  });

  it('replaces it whole from the frame, null included', () => {
    expect(CODE).toContain("case 'brief':");
    expect(CODE).toContain('briefView = msg.brief;');
  });

  /**
   * MUTANT: draw it before the panels. A window dragged to the top of the map
   * then buries the one line that says what the party is doing, permanently and
   * silently — and the notice and the targeting hint are drawn after the panels
   * for exactly this reason.
   */
  it('paints after the panels and before the combat banner', () => {
    const strip = CODE.indexOf('drawBriefStrip(ctx, briefView');
    const banner = CODE.indexOf('combatBanner?.draw(');
    const panels = CODE.indexOf('drawPartyPane(');
    expect(strip).toBeGreaterThan(-1);
    expect(panels).toBeGreaterThan(-1);
    expect(strip, 'the strip is painted under the panels').toBeGreaterThan(panels);
    expect(strip, 'the strip is painted over the combat banner').toBeLessThan(banner);
  });
});
