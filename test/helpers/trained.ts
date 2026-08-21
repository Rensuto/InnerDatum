// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import type { TalentSheet } from '../../src/server/engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   A CHARACTER WHO HAS ALREADY LEARNED EVERYTHING THEIR CLASS OWNS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `sheetForClass` honours `ClassDef.birthTalents` — four of eighteen, ToME's
 * own `talents = { [T_SHIELD_PUMMEL]=1, ... }` shape (warrior.lua:149). That is
 * correct for the game and wrong for most of this suite: a file measuring what
 * Lockdown DOES has no business also modelling the eleven levels it takes to
 * afford Lockdown, and before birth grants existed it never had to.
 *
 * ═══ WHY A HELPER AND NOT A FLAG ON `sheetForClass` ═══
 * A `trained` parameter on the production factory would be a code path that
 * only tests take, sitting in the file that decides what a real character is —
 * and the first time somebody passed it by accident, a live class would be born
 * knowing its whole tree with nothing to catch it. This lives in test/ because
 * it is a fact about fixtures, not about the game.
 *
 * ═══ IT MUTATES AND RETURNS THE SAME SHEET, ON PURPOSE ═══
 * The sheet is already attached to the engine by the time a fixture wants this,
 * so handing back a copy would train a sheet nobody is holding — which fails in
 * the most confusing possible way: everything compiles, the helper is called,
 * and the talent is still unlearned.
 *
 * USE IT FOR MECHANICS. Do NOT use it in a test that is about progression, a
 * spend path, the tier ladder or what a character is born with — those want the
 * real thing, and this would quietly delete the question they are asking.
 */
export function trained(sheet: TalentSheet, rank = 1): TalentSheet {
  for (const id of [...sheet.loadout, ...sheet.passives]) {
    // NEVER DOWNWARD. A fixture that spent points before calling this means
    // those ranks; taking them back would be a silent edit to its setup.
    sheet.points.set(id, Math.max(rank, sheet.points.get(id) ?? 0));
  }
  return sheet;
}
