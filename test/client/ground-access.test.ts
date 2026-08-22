// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { lootTipRect } from '../../src/client/ui/tooltip.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE FLOOR CAN BE READ, AND TAKEN, WITH A MOUSE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reported: "you should be able to hover your mouse over items on the ground to
 * see a tooltip. you should also be able to walk over, then click on top of it
 * to pick it up... the goal is to make picking up items, passing turns etc more
 * accessible".
 *
 * Before this, a pile on the floor was a COLOURED DOT. `GroundItemView` carried
 * `{ id, cell, itemId, tier }` and no name, so the only way to learn what a dot
 * was is to walk onto it — and a pickup COSTS A TURN, so the game charged a turn
 * to answer a question the `ground` frame could answer for free. Taking it was
 * reachable from a keybind or a right-click menu and nothing else.
 *
 * ═══ THE CLICK IS THE PART WORTH GUARDING ═══
 * It spends a turn. The rules that make it safe are all about WHERE the branch
 * sits, which is what this file pins: after the panel guard, gated on loot being
 * underfoot, and announced by the card before it fires.
 */

const SOURCE = readFileSync(new URL('../../src/client/main.ts', import.meta.url), 'utf8');

/** Comments quote the code they justify — assert against code, never prose. */
const CODE = SOURCE.split('\n')
  .filter((line) => {
    const trimmed = line.trim();
    return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
  })
  .join('\n');

function at(snippet: string): number {
  const index = CODE.indexOf(snippet);
  expect(index, `main.ts still contains: ${snippet}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe('clicking the tile you are standing on', () => {
  it('picks up what is underfoot', () => {
    at('if (me !== null && sameTile(me, tile)) {');
    at('if (lootAt(tile) === TileLoot.Underfoot) sendPickup();');
  });

  /**
   * DECISION (f) SURVIVES FOR THE BARE CASE. A click on your own token with
   * nothing under it must still do nothing — that is the commonest click on the
   * map by a wide margin, and making it emit a sentence would be noise on every
   * misclick.
   */
  it('still does nothing at all when there is nothing underfoot', () => {
    const start = at('if (me !== null && sameTile(me, tile)) {');
    const body = CODE.slice(start, start + 200);
    expect(body, 'the own-tile branch stopped returning').toContain('return;');
    expect(body, 'the own-tile branch grew an unconditional action').not.toContain('showNotice');
  });

  /**
   * ═══ IT MUST SIT AFTER THE PANEL GUARD ═══
   * Every draggable thing in this client begins on a panel, and `overPanel`
   * returning early is what makes a map mousedown unambiguously a click rather
   * than the first frame of a drag. A pickup branch placed above it would fire
   * on the press that starts a panel drag — and spend a turn doing it.
   */
  it('sits after the guard that makes a map press a click', () => {
    const panelGuard = at('if (overPanel(event.clientX, event.clientY)) {');
    const pickup = at('if (lootAt(tile) === TileLoot.Underfoot) sendPickup();');
    expect(pickup, 'the pickup branch moved above the panel guard').toBeGreaterThan(panelGuard);
  });

  /** The same call the right-click row makes — no second frame, no argument. */
  it('goes through the one pickup sender', () => {
    at('function sendPickup(');
  });
});

describe('hovering a pile', () => {
  it('is tracked on its own channel, not folded into the actor hover', () => {
    at('let hoveredLootTile: TileXY | null = null;');
    at('function noteHoveredLoot(');
  });

  /**
   * A BODY WINS. A husk standing on a coat is a husk, so the two cards can never
   * be drawn at once — and neither painter has to know the other exists.
   */
  it('yields to an actor on the same tile', () => {
    at('const next = tile === null || hasActor || lootAt(tile) === TileLoot.None ? null : tile;');
  });

  /**
   * The loot check must run BEFORE the actor hover's early return: a pointer
   * sliding from bare floor onto a loot tile leaves the actor id null on both,
   * so a check placed after that return would never fire for the commonest case.
   */
  it('is decided before the actor hover short-circuits', () => {
    const check = at('noteHoveredLoot(tile, under !== undefined);');
    const shortCircuit = CODE.indexOf('if (id === hoveredActorId) return;', check);
    expect(shortCircuit, 'the loot check fell below the actor early return').toBeGreaterThan(check);
  });

  it('is suppressed by the same three things the actor card is', () => {
    // ASSERTED AS THREE CLAUSES, NOT ONE LINE. Prettier wraps a condition this
    // long across five lines, so pinning the whole thing would pin the
    // FORMATTER rather than the rule.
    const start = at('lootTile !== null &&');
    const guard = CODE.slice(start, start + 200);
    expect(guard, 'the loot card is drawn while the pointer is unknown').toContain(
      'pointerPoint !== null',
    );
    expect(guard, 'the loot card is drawn over a dragged item').toContain('drag === null');
    expect(guard, 'the loot card is drawn over the token menu').toContain(
      'tokenMenu?.visible() !== true',
    );
  });
});

describe('the loot card lays itself out from the strings alone', () => {
  const item = (name: string) => ({ name, tier: 'common' });

  it('grows with the longest name', () => {
    const narrow = lootTipRect([item('Cap')], false, 10, 10, 800, 600);
    const wide = lootTipRect(
      [item('Reinforced Weave Watchman Greatcoat')],
      false,
      10,
      10,
      800,
      600,
    );
    expect(wide.w).toBeGreaterThan(narrow.w);
  });

  it('grows a row per item', () => {
    const one = lootTipRect([item('Cap')], false, 10, 10, 800, 600);
    const three = lootTipRect([item('Cap'), item('Boots'), item('Coat')], false, 10, 10, 800, 600);
    expect(three.h).toBeGreaterThan(one.h);
  });

  /**
   * COUNTED, NEVER SILENTLY DROPPED — a card that quietly stops listing must not
   * make the reader infer it, which is ui/caselog.ts's rule.
   */
  it('stops growing past its row cap, so a big pile cannot cover the fight', () => {
    const four = lootTipRect(
      Array.from({ length: 4 }, () => item('Cap')),
      false,
      10,
      10,
      800,
      600,
    );
    const twenty = lootTipRect(
      Array.from({ length: 20 }, () => item('Cap')),
      false,
      10,
      10,
      800,
      600,
    );
    // Four names, then one "+16 more" row — one taller than four names alone.
    expect(twenty.h).toBeLessThanOrEqual(four.h + 24);
  });

  it('stays inside the viewport at every corner', () => {
    const corners: readonly (readonly [number, number])[] = [
      [0, 0],
      [799, 599],
      [400, 599],
      [799, 300],
    ];
    for (const [px, py] of corners) {
      const rect = lootTipRect([item('Watchman Greatcoat')], true, px, py, 800, 600);
      expect(rect.x, `x at ${String(px)},${String(py)}`).toBeGreaterThanOrEqual(0);
      expect(rect.y, `y at ${String(px)},${String(py)}`).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w).toBeLessThanOrEqual(800);
      expect(rect.y + rect.h).toBeLessThanOrEqual(600);
    }
  });
});
