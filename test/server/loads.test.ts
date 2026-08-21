// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported in shape from t-engine4 game/modules/tome/data/talents/spell/explosives.lua:44-51
// — `computeDamage` branches on which infusion is currently up.
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  ALCHEMIST,
  createContentTalentEngine,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { EffectId } from '../../src/server/content/effects.ts';
import { toggleSustain } from '../../src/server/engine/talents.ts';
import {
  causticLoad,
  concussiveLoad,
  frostLoad,
  loadedWith,
  riderTurnsAt,
} from '../../src/server/talents/loads.ts';
import { practisedHands } from '../../src/server/talents/load_passives.ts';
import { EMPTY_PASSIVE_VIEW } from '../../src/server/engine/hooks.ts';
import { TALENT_MAX_LEVEL } from '../../src/shared/progression.ts';
import type { PassiveView } from '../../src/server/engine/hooks.ts';
import type { TalentActor } from '../../src/server/engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE ONLY TREE IN THE GAME THAT ADDS NO NEW BUTTON.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three stances on one slot, and what they change is what the Alchemist's
 * EXISTING throws leave behind. So the thing worth testing is not "does a load
 * go up" — `stances.test.ts` covers the machinery — but "does the throw
 * actually ASK", which is a wire between two files that nothing else checks.
 */

/** An Alchemist who has learned all three loads. */
function alchemist() {
  const engine = createContentTalentEngine();
  const sheet = sheetForClass(ALCHEMIST);
  for (const stance of [causticLoad, frostLoad, concussiveLoad]) {
    sheet.points.set(stance.id, 1);
  }
  const self = { id: 'p1' } as TalentActor;
  // `loadedWith` resolves the sheet off the ENGINE, so the fixture has to
  // attach it rather than merely hold it — the same lookup the real throw does.
  engine.attach(self.id, sheet);
  return { engine, sheet, self };
}

describe('which load is up', () => {
  it('is nothing at all until one is', () => {
    // The common case, and it must cost a throw nothing: an Alchemist who never
    // bought this tree throws exactly what they threw before.
    const { engine, self } = alchemist();
    expect(loadedWith(engine, self)).toBeNull();
  });

  it('answers the effect the load is named for', () => {
    const { engine, sheet, self } = alchemist();
    toggleSustain(engine, sheet, causticLoad.id);
    expect(loadedWith(engine, self)?.effect).toBe(EffectId.Bleeding);

    toggleSustain(engine, sheet, frostLoad.id);
    expect(loadedWith(engine, self)?.effect).toBe(EffectId.Slowed);

    toggleSustain(engine, sheet, concussiveLoad.id);
    expect(loadedWith(engine, self)?.effect).toBe(EffectId.Stunned);
  });

  it('never answers two, because they share a slot', () => {
    /**
     * THE ASSERTION THE WHOLE DESIGN RESTS ON. `loadedWith` returns the FIRST
     * match and its docblock says the order must stay irrelevant — that is only
     * true while one slot means one load. If the three ever came apart, this
     * would start silently preferring whichever is first in the table.
     */
    const { engine, sheet, self } = alchemist();
    toggleSustain(engine, sheet, causticLoad.id);
    toggleSustain(engine, sheet, frostLoad.id);
    expect(sheet.sustained.size).toBe(1);
    expect(loadedWith(engine, self)?.effect).toBe(EffectId.Slowed);
  });

  it('reports the LOAD’s rank, not the throw’s', () => {
    /**
     * What makes the tree worth deepening rather than dipping: an Alchemist who
     * has put four points into Frost Load slows for longer with the same flare.
     * Returning a boolean would have made every rank past the first cosmetic.
     */
    const { engine, sheet, self } = alchemist();
    sheet.points.set(frostLoad.id, 4);
    toggleSustain(engine, sheet, frostLoad.id);
    expect(loadedWith(engine, self)?.level).toBe(4);
    expect(riderTurnsAt(4)).toBeGreaterThan(riderTurnsAt(1));
  });

  it('will not answer for a load nobody has learned', () => {
    // Rank 0 is the ordinary state of most of a sheet since birth grants. A
    // sheet cannot hold an unlearned stance (`toggleSustain` refuses), but the
    // guard is kept here too: two seams, one rule.
    const engine = createContentTalentEngine();
    const sheet = sheetForClass(ALCHEMIST);
    const self = { id: 'p1' } as TalentActor;
    engine.attach(self.id, sheet);
    sheet.sustained.add(causticLoad.id);
    expect(loadedWith(engine, self)).toBeNull();
  });
});

describe('every throw asks', () => {
  it('is wired into all three Reagents actives', () => {
    /**
     * ═══ THE WIRE THAT MAKES THE TREE REAL, AND IT IS EASY TO HALF-DO ═══
     * A load that reached two throws of three would look like it worked — the
     * player would use the two that did and quietly conclude the third was
     * weak. Asserted on the SOURCE because the alternative is three
     * end-to-end casts for a fact that is one import per file.
     */
    const files = ['ashwick_flare', 'alchemic_vial', 'concussion_flask'];
    for (const bare of files) {
      const text = readFileSync(
        new URL(`../../src/server/talents/${bare}.ts`, import.meta.url),
        'utf8',
      );
      expect(text, `${bare} does not apply the load`).toContain('applyLoad(ctx, self, victim)');
    }
  });
});

describe('the capstone pays for holding one', () => {
  const viewOf = (over: Partial<Record<keyof PassiveView, unknown>>): PassiveView =>
    ({ ...EMPTY_PASSIVE_VIEW, ...over }) as PassiveView;

  it('is worth nothing with the bag unloaded', () => {
    const block = practisedHands.passive?.(TALENT_MAX_LEVEL, viewOf({ isSustained: () => false }));
    expect(block?.mods?.genericCrit ?? 0).toBe(0);
  });

  it('pays the same for any of the three', () => {
    // Paying more for one would put a thumb on the scale between options that
    // are deliberately equal — `corroboration.ts` makes the same call.
    const each = [causticLoad, frostLoad, concussiveLoad].map((stance) =>
      practisedHands.passive?.(3, viewOf({ isSustained: (id: string) => id === stance.id })),
    );
    expect(each[0]?.mods?.genericCrit ?? 0).toBeGreaterThan(0);
    expect(each[1]).toEqual(each[0]);
    expect(each[2]).toEqual(each[0]);
  });
});
