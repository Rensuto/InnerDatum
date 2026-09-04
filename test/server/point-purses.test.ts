// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/modules/tome/class/Actor.lua:3745-3760 (levelup grants)
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" -- https://te4.org/license

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  BIRTH_TALENT_GRANTS,
  isGenericTree,
  spentFromSpread,
  totalCategoryPointsAtLevel,
  totalGenericPointsAtLevel,
} from '../../src/shared/progression.ts';
import { CLASSES, sheetForClass, spendByPurse } from '../../src/server/content/classes.ts';
import type { ClassDef } from '../../src/server/content/classes.ts';
import type { TalentSheet } from '../../src/server/engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO OF THE FOUR POINT PURSES WERE EMPTIED BY EVERY RECONNECT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `unspentGenerics` and `unspentCategories` appear NOWHERE in
 * `persist/saves.ts`, and `createActor` starts both at zero — so any path that
 * rebuilt a body from file (a restart, a grace expiry, a character swap) emptied
 * them silently. A level-50 character is granted 42 generic points and 3
 * category points over a career.
 *
 * The fix is not to persist them. Every spend is ALREADY recorded somewhere
 * durable — talent ranks in the spread, disciplines in `unlockedTrees`,
 * deepenings in `deepenedTrees` — so all three talent-ish purses are a
 * subtraction from what the level granted, exactly as `unspentStatPoints`
 * already was. `totalGenericPointsAtLevel` and `totalCategoryPointsAtLevel` had
 * been sitting in `shared/progression.ts`, correct and tested, with ZERO
 * production callers.
 */

const anyClass = (): ClassDef => {
  const definition = CLASSES[0];
  if (definition === undefined) throw new Error('no classes are authored');
  return definition;
};

/** The tree lookup the engine supplies in production, over the class's own talents. */
function treeLookup(definition: ClassDef): (id: string) => string | undefined {
  const byId = new Map<string, string>();
  for (const talent of [
    ...definition.loadout,
    ...definition.passives,
    ...definition.birthTalents,
  ]) {
    byId.set(talent.id, talent.tree);
  }
  return (id) => byId.get(id);
}

describe('the birth grant does not split four-and-nothing', () => {
  it('every class has a birth talent in a generic tree', () => {
    /**
     * THE FACT THE WHOLE PARTITION TURNS ON, asserted rather than assumed.
     *
     * `talent:issued_kit` is generic and is one of the four. So a version that
     * handed the class partition all `BIRTH_TALENT_GRANTS` would charge a fresh
     * character for a rank it was given, and one that handed the generic
     * partition none would do the same on the other side. If content ever moves
     * it, this test says so before the ledger silently drifts.
     */
    for (const definition of CLASSES) {
      const generic = definition.birthTalents.filter((t) => isGenericTree(t.tree));
      expect(definition.birthTalents.length, definition.id).toBe(BIRTH_TALENT_GRANTS);
      expect(generic.length, `${definition.id}: no generic birth talent`).toBeGreaterThan(0);
      expect(generic.length, `${definition.id}: every birth talent is generic`).toBeLessThan(
        BIRTH_TALENT_GRANTS,
      );
    }
  });

  it('a fresh character has spent NOTHING from either purse', () => {
    // The property that makes the whole ledger safe: a body that has bought no
    // rank owes no points. A birth grant counted as a purchase would show a
    // level-1 character with a negative balance, floored to zero — which reads
    // as "you have spent your points" on a screen where nothing was spent.
    for (const definition of CLASSES) {
      const sheet = sheetForClass(definition);
      const spend = spendByPurse(sheet, definition, treeLookup(definition));
      expect(spend.class, `${definition.id} class`).toBe(0);
      expect(spend.generic, `${definition.id} generic`).toBe(0);
    }
  });
});

describe('a rank is charged to the purse that paid for it', () => {
  /** Raise one talent by `by` ranks on a fresh sheet. */
  function raised(definition: ClassDef, talentId: string, by: number): TalentSheet {
    const sheet = sheetForClass(definition);
    sheet.points.set(talentId, (sheet.points.get(talentId) ?? 0) + by);
    return sheet;
  }

  it('charges a CLASS rank to the class purse and nothing to the generic one', () => {
    const definition = anyClass();
    const talent = definition.loadout.find((t) => !isGenericTree(t.tree));
    if (talent === undefined) throw new Error('the class owns no class-tree talent');
    const spend = spendByPurse(
      raised(definition, talent.id, 2),
      definition,
      treeLookup(definition),
    );
    expect(spend.class).toBe(2);
    expect(spend.generic).toBe(0);
  });

  it('charges a GENERIC rank to the generic purse and nothing to the class one', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE DEFECT, STATED. The restore path summed the WHOLE spread against the
     * class budget, so a rank bought with a generic point was charged twice
     * over: once to the generic purse at the moment of spending, and again to
     * the class purse on the next load.
     */
    const definition = anyClass();
    // `birthTalents` IS WHERE THE GENERIC ONE IS. `GENERIC_PASSIVES` are folded
    // into the SHEET by `sheetForClass` rather than onto the class definition,
    // so `loadout` and `passives` hold no generic tree at all — the first
    // version of this fixture searched only those two and asserted nothing.
    const talent = [...definition.birthTalents, ...definition.loadout, ...definition.passives].find(
      (t) => isGenericTree(t.tree),
    );
    if (talent === undefined) throw new Error('the class owns no generic-tree talent');
    const spend = spendByPurse(
      raised(definition, talent.id, 3),
      definition,
      treeLookup(definition),
    );
    expect(spend.generic).toBe(3);
    expect(spend.class, 'a generic rank was charged to the class purse').toBe(0);
  });

  it('counts an unknown talent id as a CLASS rank rather than refunding it', () => {
    // The coarse-but-safe reading `spentTalentPoints` takes: somebody paid for
    // it, and the alternative is a silent refund on a content change.
    const definition = anyClass();
    const sheet = sheetForClass(definition);
    sheet.points.set('talent:from_a_branch_that_no_longer_exists', 2);
    const spend = spendByPurse(sheet, definition, treeLookup(definition));
    expect(spend.class).toBe(2);
  });
});

describe('spentFromSpread — the arithmetic both ledgers now share', () => {
  it('forgives the birth grant once per learned talent, capped at what exists', () => {
    // Four free ranks are owed only if four talents were learned. A spread of
    // two is owed two, and subtracting a flat four would hand its owner points
    // it never paid for.
    expect(spentFromSpread([1, 1], 4)).toBe(0);
    expect(spentFromSpread([1, 1, 1, 1], 4)).toBe(0);
    expect(spentFromSpread([2, 2, 1, 1], 4)).toBe(2);
    expect(spentFromSpread([1, 1, 1, 1, 1], 4)).toBe(1);
  });

  it('charges a 0 -> 1 purchase, which the old `raw - 1` form refunded', () => {
    /**
     * THE POINT DUPLICATION. `Σ max(0, raw - 1)` forgives a rank on EVERY entry,
     * so learning a fifth talent cost a point at the moment of spending and was
     * counted as free on the next load. Breadth was free, permanently.
     */
    const old = (ranks: readonly number[]) =>
      ranks.reduce((sum, raw) => sum + Math.max(0, raw - 1), 0);
    const learnedAFifth = [1, 1, 1, 1, 1];
    expect(old(learnedAFifth), 'the old form charged nothing for the fifth').toBe(0);
    expect(spentFromSpread(learnedAFifth, 4), 'the new form charges it once').toBe(1);
  });

  it('never goes negative', () => {
    // A class change, or a file naming fewer talents than the grant, must not
    // hand anybody points. `unspentFromLedger`'s floor exists for the same case.
    expect(spentFromSpread([], 4)).toBe(0);
    expect(spentFromSpread([0, 0], 4)).toBe(0);
  });
});

describe('the category purse is derivable, so it never needs storing', () => {
  it('is what the level granted minus every tree bought or deepened', () => {
    // `unlockTree` appends to one list and `deepenTree` to the other, and there
    // is no third way to spend the point. Both lists are persisted, so the purse
    // survives a reconnect without ever being written down.
    const at = (level: number, unlocked: number, deepened: number) =>
      Math.max(0, totalCategoryPointsAtLevel(level) - (unlocked + deepened));
    expect(at(9, 0, 0)).toBe(0);
    expect(at(10, 0, 0)).toBe(1);
    expect(at(10, 1, 0)).toBe(0);
    expect(at(36, 0, 0)).toBe(3);
    expect(at(36, 1, 1)).toBe(1);
    expect(at(36, 2, 2)).toBe(0);
  });

  it('and the generic purse is what the level granted minus generic ranks', () => {
    const definition = anyClass();
    const talent = [...definition.birthTalents, ...definition.loadout, ...definition.passives].find(
      (t) => isGenericTree(t.tree),
    );
    expect(talent, 'no generic talent to raise — this test would assert nothing').toBeDefined();
    if (talent === undefined) return;
    const sheet = sheetForClass(definition);
    sheet.points.set(talent.id, (sheet.points.get(talent.id) ?? 0) + 2);
    const spend = spendByPurse(sheet, definition, treeLookup(definition));
    expect(Math.max(0, totalGenericPointsAtLevel(12) - spend.generic)).toBe(
      totalGenericPointsAtLevel(12) - 2,
    );
  });
});

describe('the wiring, which no unit test can drive', () => {
  it('the restore path derives all three purses, and carryAcross carries them', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * A SOURCE GUARD, on `save-lines.test.ts`' terms.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `restoreProgression` and `carryAcross` are closures inside the gateway,
     * and every gateway test in the tree injects its own engine stub — the
     * reason the rule above was extracted into `spendByPurse` in the first
     * place. This is the other half: that the extraction is actually reached,
     * and that a realm door carries what a reconnect now rebuilds.
     *
     * Both were real: two purses were emptied by a reconnect AND by walking
     * through a door, which is two independent losses of the same three points.
     */
    const gateway = readFileSync(
      new URL('../../src/server/net/gateway.ts', import.meta.url),
      'utf8',
    );
    expect(gateway).toContain('engine.talentSpendOf?.(actor.id)');
    // …AND EACH IS ASKED WITH THE ORIGIN'S BONUS, not bare. A purse derived
    // without it is `earned - spent` computed against the wrong `earned`, which
    // confiscates an adaptable character's points on every single reload —
    // `PointBonus` records that failure from the other end. The argument is
    // named here so the guard fails if somebody drops it back to the bare call.
    expect(gateway).toContain(
      'totalGenericPointsAtLevel(actor.level, genericPointBonus(originHere))',
    );
    expect(gateway).toContain(
      'totalCategoryPointsAtLevel(actor.level, birthCategoryPoints(originHere))',
    );
    expect(gateway).toContain('to.unspentGenerics = from.unspentGenerics;');
    expect(gateway).toContain('to.unspentCategories = from.unspentCategories;');
  });
});
