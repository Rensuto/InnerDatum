// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/data/birth/classes/warrior.lua:149-155
// — a Bulwark is born with five talents and buys the rest.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { describe, expect, it } from 'vitest';

import {
  ALCHEMIST,
  INSPECTOR,
  WATCHMAN,
  createContentTalentEngine,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { BIRTH_INSCRIPTION_GRANTS, BIRTH_TALENT_GRANTS } from '../../src/shared/progression.ts';
import { BIRTH_INSCRIPTIONS, talentsFor } from '../../src/server/content/inscriptions.ts';
import { MIN_TIER } from '../../src/shared/tiers.ts';

const CLASSES = [WATCHMAN, INSPECTOR, ALCHEMIST];
const REGISTRY = createContentTalentEngine().registry;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   OWNING A TALENT AND HAVING LEARNED IT ARE DIFFERENT THINGS NOW.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every class was born knowing all eighteen talents it owned, so the only
 * decision a talent point ever expressed was how DEEP to go. Upstream sells the
 * breadth: a Bulwark is born with five of the dozens across its eight open
 * trees, and WHICH ones you own is the first choice a build makes.
 */

describe('what a character is born knowing', () => {
  it('is a handful, not the whole tree', () => {
    for (const definition of CLASSES) {
      const sheet = sheetForClass(definition);
      const owned = [...sheet.loadout, ...sheet.passives];
      const known = owned.filter((id) => (sheet.points.get(id) ?? 0) >= 1);
      expect(known.length, `${definition.name} is born knowing everything`).toBeLessThan(
        owned.length,
      );
      expect(known.length, `${definition.name} is born knowing nothing`).toBeGreaterThan(0);
    }
  });

  it('grants exactly what the class AND THE BODY say they grant', () => {
    /**
     * ═══ TWO SOURCES OF A FREE RANK, AND THIS ONLY KNEW ABOUT ONE ═══
     * The class grants its `birthTalents`. THE BODY grants its inscriptions —
     * `points = 1` on every `newInscription`, and `resolvers.inscription` hands
     * the talent over already learned, because an inscription is not something
     * you raise; it is written on you or it is not.
     *
     * This guard read `definition.birthTalents` alone and so demanded rank 0 for
     * everything else. That was right until inscriptions shipped and then it was
     * the only thing standing between the bar and three buttons at rank 1 —
     * except it never got the chance, because the sheet seeded them at 0 and
     * this test passed. Three infusions shipped unpressable and the guard
     * AGREED with the bug.
     */
    for (const definition of CLASSES) {
      const sheet = sheetForClass(definition);
      const granted = new Set([
        ...definition.birthTalents.map((talent) => talent.id),
        ...talentsFor(BIRTH_INSCRIPTIONS).map((talent) => talent.id),
      ]);
      for (const [id, rank] of sheet.points) {
        expect(rank, `${definition.name}: ${id}`).toBe(granted.has(id) ? 1 : 0);
      }
    }
  });

  /**
   * ═══ AND EVERY ONE OF THEM CAN ACTUALLY BE PRESSED ═══
   * THE ASSERTION THE OTHER ONE COULD NOT MAKE. `talent-scaling.test.ts` pinned
   * `sheet.points.size` — that the map has an ENTRY per inscription — which is
   * true at rank 0 as well, so membership passed while every press was refused
   * with "you have not learned that yet". A rank is not a membership.
   */
  it('seeds every inscription at a rank the engine will accept', () => {
    for (const definition of CLASSES) {
      const sheet = sheetForClass(definition);
      for (const talent of talentsFor(BIRTH_INSCRIPTIONS)) {
        expect(sheet.points.get(talent.id), `${definition.name}: ${talent.id}`).toBe(1);
      }
    }
  });

  /**
   * The persistence layer holds a COUNT of the free ranks because it may not
   * import the content tables. A fourth birth inscription that did not move this
   * number would hand every returning character a free point on every load.
   */
  it('keeps the persistence count in step with the birth list', () => {
    expect(BIRTH_INSCRIPTION_GRANTS).toBe(BIRTH_INSCRIPTIONS.length);
  });

  it('always includes something the character can attack with', () => {
    /**
     * ═══ THE ONE THAT WOULD SHIP A BROKEN CHARACTER ═══
     * The first fight starts before the first talent point exists. A class born
     * with four passives is a class that walks into the Drowned Chapel with no
     * way to hurt anything, and the game has no other opening move to fall back
     * on — this is the check that a future class definition cannot get wrong
     * quietly.
     */
    for (const definition of CLASSES) {
      const actives = definition.birthTalents.filter(
        (talent) => REGISTRY.get(talent.id)?.onUse !== undefined,
      );
      expect(actives.length, `${definition.name} is born unable to act`).toBeGreaterThan(0);
    }
  });

  it('grants only talents the class actually owns', () => {
    // A birth grant naming a talent outside the class's own lists would seed a
    // rank on a sheet that never lists it: invisible in the panel, unreachable
    // from the hotbar, and paid for out of the class's identity.
    for (const definition of CLASSES) {
      const owned = new Set(
        [...definition.loadout, ...definition.passives].map((talent) => talent.id),
      );
      for (const talent of definition.birthTalents) {
        const generic = REGISTRY.get(talent.id)?.tree.startsWith('generic/') === true;
        expect(owned.has(talent.id) || generic, `${definition.name} grants ${talent.id}`).toBe(
          true,
        );
      }
    }
  });

  it('grants only entry talents, as upstream does', () => {
    /**
     * A birth grant at tier 3 would hand a level-1 character something the tier
     * ladder says they have not earned — and the ladder would go on refusing to
     * RAISE it for eight levels, so they would own a rank-1 talent they could
     * not deepen and had not chosen.
     */
    for (const definition of CLASSES) {
      for (const talent of definition.birthTalents) {
        expect(REGISTRY.get(talent.id)?.tier ?? MIN_TIER, talent.id).toBe(MIN_TIER);
      }
    }
  });

  it('opens both of the class’s own disciplines', () => {
    /**
     * A character born inside one tree spends their whole early game there,
     * because the first points always go where the character already works.
     * Upstream is deliberate about this too — a Bulwark is born into Shield
     * Offense AND Shield Defense, not into one of them.
     */
    for (const definition of CLASSES) {
      const trees = new Set(
        definition.birthTalents
          .map((talent) => REGISTRY.get(talent.id)?.tree)
          .filter((tree): tree is string => tree !== undefined && !tree.startsWith('generic/')),
      );
      expect(trees.size, `${definition.name} is born inside one discipline`).toBe(2);
    }
  });
});

describe('the persistence ledger and the grant agree', () => {
  it('every class grants exactly BIRTH_TALENT_GRANTS talents', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE PIN THAT STOPS A POINT-DUPLICATION BUG.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `spentTalentPoints` (server/persist/saves.ts) subtracts a flat
     * `BIRTH_TALENT_GRANTS` from the sum of a saved spread to work out what was
     * actually PAID for. It cannot count the list itself — that file may not
     * import the class table, because `classId` is a soft reference there so a
     * save outlives a content edit.
     *
     * So a class granting FIVE would have one rank forgiven that it never paid
     * for, and the ledger would hand its owner a free point back on every
     * single load. Learn, reconnect, learn again, forever.
     *
     * This is the only thing holding the two numbers together, and it is
     * cheaper than the dependency that would make it automatic.
     */
    for (const definition of CLASSES) {
      expect(definition.birthTalents.length, definition.name).toBe(BIRTH_TALENT_GRANTS);
    }
  });

  it('leaves a fresh character with nothing spent', () => {
    /**
     * The arithmetic end-to-end: every RAISED rank against every GRANTED one is
     * zero points spent, which is what a level-1 character has done.
     *
     * BOTH GRANTS, and this is the assertion that would have caught the whole
     * bug from the other side. It read `raised - BIRTH_TALENT_GRANTS` and
     * balanced at 0 only because the inscriptions were seeded at rank 0 — the
     * same zero that made them unpressable. Fixing the seed unbalanced this
     * line, which is exactly what a ledger is for.
     */
    for (const definition of CLASSES) {
      const sheet = sheetForClass(definition);
      const raised = [...sheet.points.values()].reduce((sum, rank) => sum + Math.max(0, rank), 0);
      expect(raised - (BIRTH_TALENT_GRANTS + BIRTH_INSCRIPTION_GRANTS), definition.name).toBe(0);
    }
  });
});
