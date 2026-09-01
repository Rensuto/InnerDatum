// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough
// Not a port: this pins that a docblock claiming "nothing implements this" is
// still true, because three of them were not.

import { describe, expect, it } from 'vitest';

import { CLASSES } from '../../src/server/content/classes.ts';
import { TalentKind } from '../../src/server/engine/talents.ts';
import type { Talent } from '../../src/server/engine/talents.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A COMMENT SAYING SOMETHING IS UNIMPLEMENTED HAS A SHORT SHELF LIFE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `TalentKind.Sustained` carried *"Nothing implements this yet"* long after five
 * talents did — and `content/talent-trees.ts` had already written down that the
 * claim was false, quoting it, without correcting the source. The codebase held
 * both halves of the contradiction.
 *
 * That is the third stale absence-claim found in one day, and the other two cost
 * real work: `AdditiveMods` forbade `spellPower`/`mindPower` on the strength of
 * a pasted grep that had expired, and an audit finding was refuted on the
 * strength of a symbol name that did not exist.
 *
 * A general "are the docblocks true" test is not possible. THIS one is: count
 * what implements each kind, and make the count the thing a reader trusts.
 */

const everyTalent = (): readonly Talent[] =>
  CLASSES.flatMap((definition) => [
    ...definition.loadout,
    ...definition.passives,
    ...definition.birthTalents,
  ]);

describe('every talent kind the engine declares', () => {
  it('is implemented by at least one authored talent', () => {
    /**
     * THE DIRECTION THAT ROTS. A kind gains content and the comment beside it
     * goes on saying it has none — which is what happened, and what made
     * `Sustained` look like dead machinery to anybody reading the enum.
     *
     * If a kind ever genuinely has no content, this test is where that gets
     * written down, beside the count, rather than in a sentence that nothing
     * checks.
     *
     * ═══ WHAT IT DOES NOT CATCH, STATED SO NOBODY OVERTRUSTS IT ═══
     * Renaming an enum VALUE changes both sides at once — the talents write
     * `kind: TalentKind.Sustained`, so the count follows the rename and this
     * still passes. I checked, expecting it to fail, and it did not: the test
     * compares the enum to itself for that mutation.
     *
     * The scenario it DOES catch is the one that actually happens, and the one
     * that happened here: a kind DECLARED with a docblock saying nothing
     * implements it, and no content behind it. Adding a fourth member fails this
     * immediately.
     */
    const counts = new Map<string, number>();
    for (const kind of Object.values(TalentKind)) counts.set(kind, 0);
    for (const talent of everyTalent()) {
      counts.set(talent.kind, (counts.get(talent.kind) ?? 0) + 1);
    }
    for (const [kind, n] of counts) {
      expect(
        n,
        `TalentKind.${kind} has no authored talent — say so in its docblock`,
      ).toBeGreaterThan(0);
    }
  });

  it('and every sustain declares what it reserves', () => {
    /**
     * EIGHT TODAY, across five files — Careful Method, Working Fast, Legwork,
     * Loads and the Ledger stances. The count is not pinned, because content
     * growing is not a regression; what IS pinned is the invariant underneath.
     *
     * A sustain that reserves nothing is a free permanent buff, which is not
     * what the pool economy is for: `toggleSustain` prices a stance as a share
     * of the pool and displaces another when there is no room, and a stance with
     * no reservation slips past that whole rule while looking authored.
     */
    const sustained = everyTalent().filter((t) => t.kind === TalentKind.Sustained);
    expect(sustained.length).toBeGreaterThanOrEqual(2);
    for (const talent of sustained) {
      expect(talent.sustain, `${talent.id} is sustained and declares no reservation`).toBeDefined();
    }
  });
});
