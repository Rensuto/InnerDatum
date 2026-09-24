// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PROBE PRESSES A FREE BUTTON FOR FREE, AND ONLY A FREE ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `takeHelp` returns whether the press cost the turn, and delve-run swings as
 * well when it did not. That answer has to be the ENGINE'S: every talent that is
 * not `no_energy` spends a turn (tome/class/Actor.lua:5862-5863). It was read off
 * the AP price, and a talent can cost no AP and a whole turn — so the driver
 * pressed it, swung too, and measured a fight nobody can play.
 */

import { describe, expect, it } from 'vitest';

import { WATCHMAN } from '../../src/server/content/classes.ts';
import { BIRTH_INSCRIPTIONS, talentsFor } from '../../src/server/content/inscriptions.ts';
import { phaseDoorRune } from '../../src/server/talents/phase_door_rune.ts';
import { selfHelp } from '../../tools/fightlib.mjs';

describe('the probe’s self-help list', () => {
  it('marks a no_energy infusion free and one that costs a turn not free', () => {
    const free = new Map(
      selfHelp(WATCHMAN, undefined, talentsFor(BIRTH_INSCRIPTIONS)).map((h) => [h.id, h.free]),
    );
    // healing_infusion is `noEnergy`; regeneration_infusion is not, as upstream.
    expect(free.get('talent:healing_infusion')).toBe(true);
    expect(free.get('talent:regeneration_infusion')).toBe(false);
  });

  it('does not call Phase Door Rune free for having been priced at no AP — it costs the turn', () => {
    // The case that went wrong: it was priced `ap: 0`, with no `noEnergy`
    // (phase_door_rune.ts), while talents carried an AP price.
    const [rune] = selfHelp(WATCHMAN, new Set([phaseDoorRune.id]), [phaseDoorRune]);
    expect(rune?.id).toBe(phaseDoorRune.id);
    expect(rune?.free).toBe(false);
  });
});
