// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/interface/ActorTalents.lua:826-834
//             (getTalentLevel, with mastery).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { trained } from '../helpers/trained.ts';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  ALCHEMIST,
  INSPECTOR,
  SIGNATURE,
  SUPPORTING,
  WATCHMAN,
  sheetForClass,
} from '../../src/server/content/classes.ts';
import { getTalentLevelRaw, talentLevelOf } from '../../src/server/engine/talents.ts';
import { combatTalentScale } from '../../src/shared/scale.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   MASTERY: ONE FLOAT, ONE MULTIPLY, AND THREE CLASSES STOP FEELING ALIKE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `getTalentLevel(sheet, id, mastery = 1)` existed and had **zero callers
 * anywhere in `src/`**, while all seven trees shipped at mastery 1. The cheapest
 * differentiation lever in ToME was present as a defaulted parameter nobody
 * passed, because it demanded that the CALLER know where mastery lived — so no
 * caller did, and all five read `getTalentLevelRaw` instead.
 *
 * `talentLevelOf` is the version that looks it up itself, and the point of these
 * tests is as much about there being ONE answer as about the arithmetic.
 */

describe('mastery reaches the effective level', () => {
  it('multiplies the raw rank by the tree grade', () => {
    /**
     * A HAND-BUILT GRADE, because no class grants one yet — the mechanism ships
     * before the rebalance, so that the day eight talents change value there is
     * exactly one commit to revert. See SIGNATURE/SUPPORTING in content/classes.ts.
     */
    const sheet = trained(sheetForClass(WATCHMAN));
    const talent = WATCHMAN.loadout[0];
    expect(talent, 'the Watchman has no talents').toBeDefined();
    if (talent === undefined) return;

    const raw = getTalentLevelRaw(sheet, talent.id);
    expect(raw, 'not learned, so this proves nothing').toBeGreaterThan(0);
    // The Watchman GRADES both his trees now, so his own talents are not the
    // ungraded case. Groundwork is — it is deliberately 1.0 for everybody.
    const generic = sheet.passives.find((id) => id.includes('long_service'));
    expect(generic, 'the generic tree is not on this sheet').toBeDefined();

    // A graded tree multiplies; an ungraded one does not. Both, side by side.
    const graded = { ...sheet, mastery: new Map([[talent.tree, SIGNATURE]]) };
    const ungraded = { ...sheet, mastery: new Map<string, number>() };
    expect(talentLevelOf(graded, talent)).toBeCloseTo(raw * SIGNATURE, 5);
    expect(talentLevelOf(ungraded, talent), 'an ungraded tree must be untouched').toBe(raw);
  });

  it('leaves the generic tree at 1.0 for everybody', () => {
    /**
     * Groundwork is what everyone is taught. A class BETTER at it would be a
     * class that is better at being a person, and upstream leaves its own
     * generic trees ungraded for the same reason.
     */
    for (const definition of [WATCHMAN, INSPECTOR, ALCHEMIST]) {
      const sheet = trained(sheetForClass(definition));
      const generic = [...definition.loadout, ...definition.passives].find(
        (t) => t.tree === 'generic/groundwork',
      );
      // The generic passives are joined at the SHEET, so look them up by id.
      const id = generic?.id ?? 'talent:long_service';
      const known = sheet.points.has(id);
      expect(known, 'the generic tree is not on this sheet at all').toBe(true);
      expect(sheet.mastery.get('generic/groundwork') ?? 1).toBe(1);
    }
  });
});

describe('the grants themselves', () => {
  it('gives every class exactly one signature and one supporting tree', () => {
    /**
     * A class with BOTH trees at 1.30 is differentiated from the other classes
     * and says nothing about itself. The split says what it is FOR: the Watchman
     * is a man holding a doorway who can also hit people; the Inspector is a shot
     * who can also disappear; the Alchemist is a chemist who can also patch you
     * up. That is texture inside a build as well as between builds.
     */
    for (const definition of [WATCHMAN, INSPECTOR, ALCHEMIST]) {
      const grades = Object.values(definition.masteries ?? {});
      expect(grades, `${definition.name} grades no trees`).toHaveLength(2);
      expect(Math.max(...grades)).toBeCloseTo(SIGNATURE, 5);
      expect(Math.min(...grades)).toBeCloseTo(SUPPORTING, 5);
    }
  });

  it('never grades a tree the class has no talent in', () => {
    for (const definition of [WATCHMAN, INSPECTOR, ALCHEMIST]) {
      const owned = new Set([...definition.loadout, ...definition.passives].map((t) => t.tree));
      for (const tree of Object.keys(definition.masteries ?? {})) {
        expect(owned.has(tree), `${definition.name} grades ${tree}, which it never touches`).toBe(
          true,
        );
      }
    }
  });

  it('leaves the generic tree at 1.0 for everybody', () => {
    /**
     * Groundwork is what everyone is taught. A class BETTER at it would be a
     * class that is better at being a person, and upstream leaves its own generic
     * trees ungraded for the same reason.
     */
    for (const definition of [WATCHMAN, INSPECTOR, ALCHEMIST]) {
      const sheet = trained(sheetForClass(definition));
      expect(sheet.mastery.get('generic/groundwork') ?? 1).toBe(1);
    }
  });

  it('makes a signature talent outrank a supporting one at the same points', () => {
    /**
     * ═══ THE WHOLE POINT, IN ONE ASSERTION ═══
     * Two talents, same class, same points spent, different trees — and they do
     * NOT resolve at the same rank. That is the difference between a class that
     * has two trees and a class that is ABOUT one of them.
     */
    const sheet = trained(sheetForClass(WATCHMAN));
    const pick = (tree: string) =>
      [...WATCHMAN.loadout, ...WATCHMAN.passives].find((t) => t.tree === tree);
    const line = pick('watch/the-line');
    const discipline = pick('watch/discipline');
    expect(line, "no talent in the Watchman's signature tree").toBeDefined();
    expect(discipline, "no talent in the Watchman's supporting tree").toBeDefined();
    if (line === undefined || discipline === undefined) return;

    expect(getTalentLevelRaw(sheet, line.id)).toBe(getTalentLevelRaw(sheet, discipline.id));
    expect(talentLevelOf(sheet, line)).toBeGreaterThan(talentLevelOf(sheet, discipline));
    expect(talentLevelOf(sheet, discipline)).toBeGreaterThan(
      getTalentLevelRaw(sheet, discipline.id),
    );
  });
});

describe('the multiply happens to the LEVEL, not to the result', () => {
  it('is worth much less than the multiplier suggests, which is correct', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE ONE EASY WAY TO GET MASTERY WRONG, AND IT DOES NOT LOOK WRONG.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The scaling curves are sublinear, so pushing along the x-axis is not the
     * same as scaling the output. Upstream measures 1.3 mastery on Weapons
     * Mastery as roughly +14% of actual value, NOT +30%.
     *
     * Scaling the RESULT instead would produce a class gap more than twice as
     * wide as ToME feels, and every band in the game would need re-tuning to
     * compensate — silently, because the number would still look plausible.
     */
    const raw = 3;
    const LOW = 1;
    const HIGH = 5;
    const CURVE = 0.75;

    const correct = combatTalentScale(raw * 1.3, LOW, HIGH, CURVE);
    const wrong = combatTalentScale(raw, LOW, HIGH, CURVE) * 1.3;
    const base = combatTalentScale(raw, LOW, HIGH, CURVE);

    expect(correct, 'mastery bought nothing').toBeGreaterThan(base);
    expect(correct, 'level-then-scale is not cheaper than scale-then-multiply').toBeLessThan(wrong);

    // And by roughly the margin upstream reports: well under the headline 30%.
    const gain = (correct - base) / base;
    expect(gain).toBeLessThan(0.3);
    expect(gain).toBeGreaterThan(0);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   AND EVERY SITE ASKS THE SAME FUNCTION.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Five call sites independently answered "what rank is this talent behaving at"
 * — the loadout view twice, the range check, the use context, and the passive
 * fold, which read the point map directly. That is [M-002], and the failure it
 * produces is a panel that disagrees with the damage.
 *
 * Source-shape, because "nobody computes this a sixth way" is a fact about the
 * codebase rather than about a return value.
 */
const SOURCES = [
  'src/server/engine/talents.ts',
  'src/server/content/classes.ts',
  'src/server/main.ts',
];

describe('one answer to what rank a talent behaves at', () => {
  it('leaves no raw-rank reads at the sites that resolve a talent', () => {
    const offenders: string[] = [];
    for (const rel of SOURCES) {
      const text = readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
      for (const [i, line] of text.split('\n').entries()) {
        // The DEFINITION of the raw reader, and `talentLevelOf`'s own body, are
        // the two legitimate mentions.
        if (!line.includes('getTalentLevelRaw(')) continue;
        // COMMENTS ARE NOT CALL SITES. Three of the four this first caught were
        // upstream's Lua quoted verbatim in a docblock, which is exactly the
        // citation discipline the port is supposed to keep.
        const code = line.trim();
        if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) continue;
        if (line.includes('export function getTalentLevelRaw')) continue;
        if (line.includes('return getTalentLevelRaw(sheet, id) * mastery')) continue;
        if (line.includes('getTalentLevelRaw(sheet, talent.id) * (sheet.mastery')) continue;
        /**
         * AND THE COUNTER, WHICH MUST STAY RAW. `toLoadoutView` draws "3/5"
         * from this and gates the `+` on it — routing it through mastery shows
         * a Watchman "5.2/5" and turns his last point unspendable. Upstream
         * keeps the same split: LevelupDialog prints `traw`.
         *
         * ═══ A MARKER, NOT AN EXPRESSION. THE EXPRESSION WAS THE BUG. ═══
         * This allowance used to name the exact text
         * `BIRTH_TALENT_LEVEL, getTalentLevelRaw(sheet, id)` — the counter as
         * it happened to be spelled, floor and all. When birth grants landed
         * and the floor came off (a class is born knowing four of eighteen, so
         * rank 0 is now an ordinary state), the allowance silently stopped
         * matching and this test failed on two lines that were entirely
         * correct. An allow-list keyed on incidental syntax fails on a
         * REFORMAT, which is the worst kind of guard: it cries wolf on
         * innocent changes and teaches its readers to widen it without
         * thinking.
         *
         * Keyed on a DECLARATION instead. A raw read that is genuinely the
         * counter says so on its own line, and any new raw read that does not
         * is caught — which is the rule this test was always trying to state.
         */
        const marker = /\/\/ RAW: *(.+)/.exec(line);
        // A BARE MARKER IS NOT A JUSTIFICATION. The reason has to be written
        // down, because the whole point is to force the thought once.
        if (marker !== null && (marker[1] ?? '').trim().length > 8) continue;
        offenders.push(`${rel}:${String(i + 1)}`);
      }
    }
    expect(
      offenders,
      'a site is resolving a talent at its RAW rank again — it will ignore mastery',
    ).toEqual([]);
  });
});
