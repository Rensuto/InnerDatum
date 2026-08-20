// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Ported from t-engine4 game/engines/default/engine/interface/ActorTalents.lua:826-834
//             (getTalentLevel, with mastery).
// T-Engine4 (C) 2009-2018 Nicolas Casalini "DarkGod" — https://te4.org/license

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  ALCHEMIST,
  INSPECTOR,
  SIGNATURE,
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
    const sheet = sheetForClass(WATCHMAN);
    const talent = WATCHMAN.loadout[0];
    expect(talent, 'the Watchman has no talents').toBeDefined();
    if (talent === undefined) return;

    const raw = getTalentLevelRaw(sheet, talent.id);
    expect(raw, 'not learned, so this proves nothing').toBeGreaterThan(0);
    expect(talentLevelOf(sheet, talent), 'ungraded trees must be unchanged').toBe(raw);

    const graded = { ...sheet, mastery: new Map([[talent.tree, SIGNATURE]]) };
    expect(talentLevelOf(graded, talent)).toBeCloseTo(raw * SIGNATURE, 5);
  });

  it('leaves the generic tree at 1.0 for everybody', () => {
    /**
     * Groundwork is what everyone is taught. A class BETTER at it would be a
     * class that is better at being a person, and upstream leaves its own
     * generic trees ungraded for the same reason.
     */
    for (const definition of [WATCHMAN, INSPECTOR, ALCHEMIST]) {
      const sheet = sheetForClass(definition);
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
        // AND THE COUNTER, WHICH MUST STAY RAW. `toLoadoutView` draws "3/5" from
        // this and gates the `+` on it — routing it through mastery shows a
        // Watchman "5.2/5" and turns his last point unspendable. Upstream keeps
        // the same split: LevelupDialog prints `traw`.
        if (line.includes('BIRTH_TALENT_LEVEL, getTalentLevelRaw(sheet, id)')) continue;
        offenders.push(`${rel}:${String(i + 1)}`);
      }
    }
    expect(
      offenders,
      'a site is resolving a talent at its RAW rank again — it will ignore mastery',
    ).toEqual([]);
  });
});
