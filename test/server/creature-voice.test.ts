// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *   THE BESTIARY IS NOT A FILING SYSTEM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The direction, in the author's own words:
 *
 *     "we are going for more void-eldritch-horror esque style. we are not a
 *      filing system. this is essentially creatures on the edge of 'reality'."
 *
 * So a creature is a thing at the thinning edge of what exists — torn, unmade,
 * wrong-angled, hungering, half-present. It is not an office. `the Index`, `the
 * Veil`, `the Redaction` and `ERASED` stay as proper nouns of the world and are
 * described as VOID; the clerical props are gone.
 *
 * ═══ WHY A RULE AND NOT A RE-PIN ═══
 * `monsters.test.ts` pins three descriptions by fragment, which proves those
 * three sentences and nothing about the fourteenth creature somebody adds next
 * year. This file asks the question the direction actually asks — "is there
 * stationery in the bestiary" — of EVERY monster template, every monster talent
 * and every roamer label at once, so the rule survives the roster growing.
 *
 * It reads the three surfaces a player actually sees a creature through:
 *   - `MONSTER_TEMPLATES` — the inspect panel and the Case Log's names
 *   - `MONSTER_TALENTS` — the talent name and its rendered description
 *   - `ROAMER_KINDS` / `REDACTED_KINDS` — the label on an overworld marker
 *
 * WHOLE WORDS, CASE-INSENSITIVE, for `monsters.test.ts`'s reason: a substring
 * test fails on "stampede" and "marginal" and teaches nothing when it does.
 */

import { describe, expect, it } from 'vitest';

import { MONSTER_TEMPLATES } from '../../src/server/content/monsters.ts';
import { MONSTER_TALENTS } from '../../src/server/talents/monster.ts';
import { REDACTED_KINDS, ROAMER_KINDS } from '../../src/server/world/roamers.ts';
import { createWorld } from '../../src/server/world/world.ts';

/**
 * THE VOCABULARY THAT IS NOT THIS GAME'S.
 *
 * Every entry is a whole word or a whole phrase. Plurals and the one inflection
 * a brief actually reaches for ("stamped") are listed rather than stemmed,
 * because a stemmer here would be a second thing to debug.
 */
const PAPERWORK = [
  'ledger',
  'ledgers',
  'ink',
  'inks',
  'inkwell',
  'inkwells',
  'page',
  'pages',
  'typewriter',
  'typewriters',
  'deed',
  'deeds',
  'filing',
  'file cabinet',
  'file cabinets',
  'filing cabinet',
  'filing cabinets',
  'clerk',
  'clerks',
  'stamp',
  'stamps',
  'stamped',
  'citation',
  'citations',
  'dossier',
  'dossiers',
  'footnote',
  'footnotes',
  'margin',
  'margins',
  'catalogue',
  'catalogues',
  'folder',
  'folders',
  'notary',
  'notaries',
  'paperwork',
] as const;

/** A whole-word (or whole-phrase) hit, case-insensitive. */
function paperworkIn(text: string): readonly string[] {
  return PAPERWORK.filter((word) => new RegExp(`\\b${word}\\b`, 'i').test(text));
}

/** `where` names the surface, so a failure says which string to rewrite. */
function noPaperwork(where: string, text: string): void {
  expect({ where, found: paperworkIn(text) }).toEqual({ where, found: [] });
}

/**
 * A REAL BODY FOR `describe`, not a cast literal.
 *
 * `uncorroborated.test.ts` makes the same argument: a stub compiles today and
 * hides the day a description starts reading the caster.
 */
const reader = createWorld('creature-voice').addPlayer('p1', 'Ren');

/** Level 1 and level 5, because a description may only say it at high rank. */
const LEVELS = [1, 5] as const;

describe('no creature a player can read is made of stationery', () => {
  /**
   * AND EACH ONE COUNTS WHAT IT READ. An empty roster passes a for-loop in
   * silence, which is how a scrape stops scraping — see `run the probes`.
   */
  it('keeps every monster name and description in the void register', () => {
    for (const template of MONSTER_TEMPLATES) {
      noPaperwork(`${template.id}.displayName`, template.displayName);
      noPaperwork(`${template.id}.description`, template.description);
    }
    expect(MONSTER_TEMPLATES.length).toBeGreaterThanOrEqual(12);
  });

  it('keeps every monster talent name and description in the void register', () => {
    for (const talent of MONSTER_TALENTS) {
      noPaperwork(`${talent.id}.name`, talent.name);
      for (const level of LEVELS) {
        noPaperwork(`${talent.id}.describe(${String(level)})`, talent.describe(reader, level));
      }
    }
    expect(MONSTER_TALENTS.length).toBeGreaterThanOrEqual(8);
  });

  it('keeps every roamer label in the void register', () => {
    const kinds = [...ROAMER_KINDS, ...REDACTED_KINDS];
    for (const kind of kinds) {
      noPaperwork(`roamer:${kind.template.id}`, kind.label);
    }
    expect(kinds.length).toBeGreaterThanOrEqual(8);
  });

  /**
   * THE GUARD'S OWN GUARD. A list that matched nothing would pass this file for
   * ever without reading a word of the bestiary, which is the failure mode every
   * scrape in this repository has had at least once.
   */
  it('would actually catch a word if one came back', () => {
    expect(paperworkIn('A husk the Index kept editing. The pages have set.')).toEqual(['pages']);
    expect(paperworkIn('An inkwell that went under and kept spilling.')).toEqual(['inkwell']);
    // ...and not on a word that merely contains one.
    expect(paperworkIn('It stampedes past the marginalia of a paginated inkling.')).toEqual([]);
  });
});
