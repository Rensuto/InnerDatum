// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// The rule under test is ported from t-engine4 game/modules/tome/class/Actor.lua:4773-4783.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { describe, expect, it } from 'vitest';

import { RESPEC_WINDOW, dropSpend, noteSpend, unlearnableAt } from '../../src/shared/respec.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A WINDOW, NOT AN UNDO — and every test here is about the difference.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The feature is only worth having if it is BOUNDED. An unlimited refund makes
 * a build a suggestion; four spends deep makes a mis-click recoverable and
 * leaves the decision intact. So the interesting assertions are all about what
 * this REFUSES.
 */

describe('the ledger keeps the last few and forgets the rest', () => {
  it('keeps upstream’s own two sizes rather than one tidy number', () => {
    // `what == "generic" and 3 or 4`. The asymmetry is upstream's: generic
    // points arrive on a scarcer schedule, so an equal window would make the
    // generic one proportionally far more forgiving.
    expect(RESPEC_WINDOW.class).toBe(4);
    expect(RESPEC_WINDOW.generic).toBe(3);
  });

  it('drops the OLDEST when the window is full', () => {
    /**
     * `table.remove(list, 1)` — from the FRONT. Trimming the back instead would
     * discard the spend that was just made, which is the one thing a player is
     * most likely to want back, and the test would still look like it passed
     * because the list would still be the right length.
     */
    let ledger: string[] = [];
    for (const id of ['a', 'b', 'c', 'd', 'e']) ledger = noteSpend(ledger, id, 'class');
    expect(ledger).toEqual(['b', 'c', 'd', 'e']);
    expect(unlearnableAt(ledger, 'a'), 'the oldest spend is still refundable').toBe(-1);
  });

  it('closes the generic window a spend sooner', () => {
    let ledger: string[] = [];
    for (const id of ['a', 'b', 'c', 'd']) ledger = noteSpend(ledger, id, 'generic');
    expect(ledger).toEqual(['b', 'c', 'd']);
  });

  it('records a spend per RANK, not per talent', () => {
    /**
     * Three ranks of one talent are three entries, so three take-backs. Naive
     * deduplication would make the second rank of anything permanently
     * unrefundable while the first stayed open — a rule no player could predict
     * and none would ever be told.
     */
    let ledger: string[] = [];
    for (let i = 0; i < 3; i += 1) ledger = noteSpend(ledger, 'talent:iron_curtain', 'class');
    expect(ledger).toEqual(['talent:iron_curtain', 'talent:iron_curtain', 'talent:iron_curtain']);
  });

  it('finds the MOST RECENT entry for a talent bought twice', () => {
    // `for i = #list, min, -1` — backwards. Taking the oldest would refund a
    // rank bought long ago and strand the fresh one, and the two are
    // indistinguishable to everything downstream.
    const ledger = ['x', 'talent:a', 'y', 'talent:a'];
    expect(unlearnableAt(ledger, 'talent:a')).toBe(3);
  });

  it('says no to a talent that was never spent on', () => {
    expect(unlearnableAt(['a', 'b'], 'talent:never')).toBe(-1);
    expect(unlearnableAt([], 'a')).toBe(-1);
  });

  it('takes exactly one entry out, leaving the other copy behind', () => {
    const ledger = ['a', 'b', 'a'];
    expect(dropSpend(ledger, 2)).toEqual(['a', 'b']);
    // AND THE REMAINING COPY IS STILL REFUNDABLE — one press, one rank.
    expect(unlearnableAt(dropSpend(ledger, 2), 'a')).toBe(0);
  });

  it('never mutates the ledger it was handed', () => {
    // The body's ledger is replaced wholesale by the caller, so nothing can hold
    // a stale reference to a list that has since been trimmed — and
    // `src/shared/` may not be the place a hidden write happens.
    const ledger = ['a', 'b'];
    noteSpend(ledger, 'c', 'class');
    dropSpend(ledger, 0);
    expect(ledger).toEqual(['a', 'b']);
  });

  it('answers an out-of-range drop with the list unchanged', () => {
    // A corrupt index is a repair case, not a throw: it is reachable from a
    // hand-edited save, and refusing to load a character over one is worse than
    // declining the refund.
    expect(dropSpend(['a'], -1)).toEqual(['a']);
    expect(dropSpend(['a'], 9)).toEqual(['a']);
  });
});
