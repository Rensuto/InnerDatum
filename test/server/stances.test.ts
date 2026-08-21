// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/talents/celestial/chants.lua:31
// (`sustain_positive = 20`) and class/Actor.lua:5922-5931 (a slot displaces).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { describe, expect, it } from 'vitest';

import {
  INSPECTOR,
  createContentTalentEngine,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { toggleSustain } from '../../src/server/engine/talents.ts';
import { carefulMethod } from '../../src/server/talents/careful_method.ts';
import { corroboration } from '../../src/server/talents/corroboration.ts';
import { workingFast } from '../../src/server/talents/working_fast.ts';
import { EMPTY_PASSIVE_VIEW } from '../../src/server/engine/hooks.ts';
import type { PassiveView } from '../../src/server/engine/hooks.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE STANCE SYSTEM WAS BUILT, CORRECT, AND REACHABLE BY NOTHING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Talent.sustain`, `sustainSlot`, `toggleSustain` with its careful
 * displace-then-test ordering, `TalentSheet.sustained`, the passive fold's
 * `[...sheet.passives, ...sheet.sustained]`, `PassiveView.isSustained`, the
 * gateway's toggle branch and `LoadoutTalent.sustained` on the wire — every
 * piece shipped, and `TalentKind.Sustained` said so in as many words:
 * *"Nothing implements this yet."* Forty-eight talents, zero stances.
 *
 * The engine's own tests covered the MACHINERY against fixtures. These are the
 * first over content that actually ships, which is a different question: not
 * "does `toggleSustain` displace" but "do the two things a player can press
 * displace each other, and does the pool have room for either".
 */

/** A fresh Inspector, trained enough to hold a stance. */
function inspector() {
  const engine = createContentTalentEngine();
  const sheet = sheetForClass(INSPECTOR);
  // LEARNED, because a sustain answers `Unknown` for a talent the sheet has no
  // points in — the same rule `raiseTalentPoint` spends against. A class is
  // born knowing four of its talents and neither method is one of them.
  sheet.points.set(carefulMethod.id, 1);
  sheet.points.set(workingFast.id, 1);
  return { engine, sheet };
}

describe('the two methods are one decision', () => {
  it('goes up, and is remembered', () => {
    const { engine, sheet } = inspector();
    expect(toggleSustain(engine, sheet, carefulMethod.id)).toEqual({ ok: true, on: true });
    expect(sheet.sustained.has(carefulMethod.id)).toBe(true);
  });

  it('comes back down on a second press', () => {
    // The bar's `sustained` flag is what tells a player which way the key will
    // go next; a stance that could only go up would strand the pool.
    const { engine, sheet } = inspector();
    toggleSustain(engine, sheet, carefulMethod.id);
    expect(toggleSustain(engine, sheet, carefulMethod.id)).toEqual({ ok: true, on: false });
    expect(sheet.sustained.has(carefulMethod.id)).toBe(false);
  });

  it('displaces its twin rather than refusing it', () => {
    /**
     * ═══ Actor.lua:5922-5931, AND IT IS A FEEL DECISION AS MUCH AS A PORT ═══
     * Refusing would make changing stance a two-press chore in the middle of a
     * fight — put the old one down, pick the new one up — for no gain. This is
     * the assertion that the two share a slot at all: authored on different
     * files, they agree only because both name `METHOD_SLOT`.
     */
    const { engine, sheet } = inspector();
    toggleSustain(engine, sheet, carefulMethod.id);
    expect(toggleSustain(engine, sheet, workingFast.id)).toEqual({ ok: true, on: true });
    expect(sheet.sustained.has(workingFast.id)).toBe(true);
    expect(sheet.sustained.has(carefulMethod.id), 'both methods are up at once').toBe(false);
  });

  it('leaves room for the class to act', () => {
    /**
     * A RESERVATION IS ROOM, NOT SPENDING. Focus is a 0-100 pool and a method
     * holds twenty of the CEILING while it is up — so an Inspector in a stance
     * has eighty to work with, not a countdown. A reserve that swallowed the
     * pool would make the stance a choice between having it and playing.
     */
    const { engine, sheet } = inspector();
    toggleSustain(engine, sheet, carefulMethod.id);
    expect(sheet.resource.value).toBeGreaterThan(0);
    expect(sheet.resource.value).toBeLessThan(sheet.resource.max);
  });

  it('gives the reservation back when it goes down', () => {
    const { engine, sheet } = inspector();
    const before = sheet.resource.value;
    toggleSustain(engine, sheet, carefulMethod.id);
    const held = sheet.resource.value;
    toggleSustain(engine, sheet, carefulMethod.id);
    expect(held).toBeLessThan(before);
    // The CEILING is what a reservation moves; the value stays where the
    // clamp left it and refills normally. What must not happen is the ceiling
    // staying low after the stance is down.
    expect(sheet.resource.max - held).toBeGreaterThan(0);
  });

  it('refuses a stance the character has not learned', () => {
    // Rank 0 is the ordinary state of most of a sheet since birth grants
    // landed. A stance you could hold without buying it would make the whole
    // tree free.
    const engine = createContentTalentEngine();
    const sheet = sheetForClass(INSPECTOR);
    expect(toggleSustain(engine, sheet, carefulMethod.id).ok).toBe(false);
  });
});

describe('the tree pays for holding one', () => {
  const viewOf = (over: Partial<Record<keyof PassiveView, unknown>>): PassiveView =>
    ({ ...EMPTY_PASSIVE_VIEW, ...over }) as PassiveView;

  it('Corroboration is worth nothing with no method up', () => {
    const block = corroboration.passive?.(5, viewOf({ isSustained: () => false }));
    expect(block?.mods?.physResist ?? 0).toBe(0);
  });

  it('pays the same for either method, which keeps the pair a real choice', () => {
    /**
     * Paying more for one would put a thumb on the scale between two options
     * that are deliberately equal — and the pair only works as a decision while
     * neither is the default.
     */
    const careful = corroboration.passive?.(
      3,
      viewOf({ isSustained: (id: string) => id === carefulMethod.id }),
    );
    const fast = corroboration.passive?.(
      3,
      viewOf({ isSustained: (id: string) => id === workingFast.id }),
    );
    expect(careful?.mods?.physResist ?? 0).toBeGreaterThan(0);
    expect(careful).toEqual(fast);
  });

  it('moves all three saves, which is the channel this class cannot buy', () => {
    const block = corroboration.passive?.(3, viewOf({ isSustained: () => true }));
    expect(block?.mods?.physResist).toBe(block?.mods?.mentalResist);
    expect(block?.mods?.physResist).toBe(block?.mods?.spellResist);
  });
});

describe('a stance is a passive you can switch off', () => {
  it('contributes through `passive`, like gear and every other talent', () => {
    /**
     * The design that keeps the fold single. Giving sustains their own
     * contribution type would be a second combine to keep in step with the
     * first, and the first is what gear already stacks through.
     */
    for (const stance of [carefulMethod, workingFast]) {
      expect(stance.passive, stance.name).toBeDefined();
      expect(stance.sustain, stance.name).toBeDefined();
      // NO BODY. A stance is toggled, never resolved — the gateway tries
      // `toggleSustain` first and only falls through to `submitTalent` when it
      // answers undefined, so an `onUse` here would be unreachable code.
      expect(stance.onUse, stance.name).toBeUndefined();
    }
  });

  it('costs no action points, so changing stance mid-fight is possible', () => {
    // Charging AP would mean putting one up costs a turn's action, and a player
    // would simply never change stance during the one moment it is interesting.
    for (const stance of [carefulMethod, workingFast]) {
      expect(stance.cost.ap ?? 0, stance.name).toBe(0);
    }
  });
});
