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

  it('grants exactly what the class says it grants', () => {
    for (const definition of CLASSES) {
      const sheet = sheetForClass(definition);
      const granted = new Set(definition.birthTalents.map((talent) => talent.id));
      for (const [id, rank] of sheet.points) {
        expect(rank, `${definition.name}: ${id}`).toBe(granted.has(id) ? 1 : 0);
      }
    }
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
