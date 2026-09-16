// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { readFileSync, readdirSync } from 'node:fs';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  BOSS_ART_COMMISSION,
  EFFECT_ART_COMMISSION,
  ENEMY_ART_COMMISSION,
  ITEM_ART_COMMISSION,
  PROP_ART_COMMISSION,
  STATUS_ICON_ART_COMMISSION,
  TOWNSFOLK_ART_COMMISSION,
} from '../../content/art-requests.ts';
import type { ArtRequest } from '../../content/art-requests.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE COMMISSION IS READ BY A SCANNER, SO IT HAS TO BE WHAT THE SCANNER READS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The ids follow `tools/art-needs.mjs`'s shape — one of its stems, then
 * lower-case words joined by underscores — so the day one is wired, the
 * inventory counts it. Until then they stay out of that inventory: the
 * repository keeps no `*ART_REQUESTS` constant, and an id in an `id:` field is
 * a name to the scanner, not a picture.
 */
const STEMS = ['chr_npc_', 'enemy_', 'icon_', 'item_', 'prop_', 'ui_'] as const;
const ID = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

const ALL: readonly (readonly [string, readonly ArtRequest[]])[] = [
  ['townsfolk', TOWNSFOLK_ART_COMMISSION],
  ['enemies', ENEMY_ART_COMMISSION],
  ['bosses', BOSS_ART_COMMISSION],
  ['effects', EFFECT_ART_COMMISSION],
  ['status icons', STATUS_ICON_ART_COMMISSION],
  ['items', ITEM_ART_COMMISSION],
  ['props', PROP_ART_COMMISSION],
];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A SOURCE FILE NAMES AS A PICTURE: ITS STRINGS, AS THE PARSER SEES THEM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every string literal and every template with no `${}` in it, minus the value
 * of an `id:` field. That last cut is the commission header's own rule — an id
 * in an `id:` field is a name, not a picture — and src/ needs it for the same
 * reason: an item is `id: 'item_watchmans_cap'` beside `icon:
 * 'item_watchmans_cap'`, and only the icon is drawn. A ported item whose
 * picture is still a stand-in keeps its commission entry.
 *
 * PARSED, NOT STRIPPED WITH A REGEX. The repository's usual cut (drop every
 * block comment, then everything after `//` on a line, as
 * test/server/live-mods.test.ts does) happens to lose none of src/'s asset
 * strings today. But it reads `'a // b'` as a comment that eats the rest of its
 * line, and a string holding `/*` as a comment that eats everything up to the
 * next close. Both hide a sprite from this check, which is the one direction it
 * must not fail in. TypeScript's own parser cannot disagree with the compiler
 * about where a comment is.
 *
 * WHAT IT CANNOT SEE: an id built at runtime (`chr_npc_${name}_s`), the same
 * blind spot tools/art-needs.mjs states about itself.
 */
function picturesNamedIn(text: string, fileName: string): Set<string> {
  const named = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'id') {
      let value: ts.Expression = node.initializer;
      while (
        ts.isAsExpression(value) ||
        ts.isSatisfiesExpression(value) ||
        ts.isParenthesizedExpression(value)
      ) {
        value = value.expression;
      }
      if (ts.isStringLiteralLike(value)) return;
    }
    if (ts.isStringLiteralLike(node)) named.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS));
  return named;
}

const SRC = new URL('../../src/', import.meta.url);

function sourceFiles(dir: URL, into: URL[] = []): URL[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) sourceFiles(new URL(`${entry.name}/`, dir), into);
    else if (entry.name.endsWith('.ts')) into.push(new URL(entry.name, dir));
  }
  return into;
}

describe('the standing art commission', () => {
  it('names every piece with an id the art scanner will count', () => {
    for (const [list, requests] of ALL) {
      expect(requests.length, `${list} is empty`).toBeGreaterThan(0);
      for (const { id } of requests) {
        expect(
          STEMS.some((stem) => id.startsWith(stem) && id.length > stem.length) && ID.test(id),
          `${list}: ${id} is not an asset id the scanner reads`,
        ).toBe(true);
      }
    }
  });

  it('asks for each piece once', () => {
    const ids = ALL.flatMap(([, requests]) => requests.map((r) => r.id));
    const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(repeated, 'an id is requested twice').toEqual([]);
  });

  it('gives every piece a size from the scale contract and a brief to draw from', () => {
    for (const [list, requests] of ALL) {
      for (const { id, size, brief, where } of requests) {
        expect(brief.trim().length, `${list}: ${id} has no brief`).toBeGreaterThan(10);
        expect(where.trim().length, `${list}: ${id} says nowhere`).toBeGreaterThan(0);
        // STANDING BODIES FACE SOUTH IN ONE FRAME, and the id says so the way
        // every shipped actor's does.
        if (size === '48x64') expect(id.endsWith('_s'), `${list}: ${id} is a body`).toBe(true);
        if (id.startsWith('ui_fx_')) {
          expect(['256x64', '384x64'], `${list}: ${id} is not a strip`).toContain(size);
        }
        if (id.startsWith('icon_') || id.startsWith('item_') || id.startsWith('prop_')) {
          expect(size, `${list}: ${id} is not one cell`).toBe('64x64');
        }
      }
    }
  });

  it('spells every id out in an `id:` field, where the art inventory leaves it alone', () => {
    /**
     * An id built from a template is one nobody can search for, and an id passed
     * anywhere but an `id:` field is read by tools/art-needs.mjs as art the code
     * already draws. Both happened to this file once: thirty-six effects were
     * built from a template, and the first version's constants were counted as
     * requests by an inventory that is meant to hold none.
     */
    const text = readFileSync(new URL('../../content/art-requests.ts', import.meta.url), 'utf8');
    expect(/\bconst\s+[A-Z_]*ART_REQUESTS\b/.test(text), 'a constant is a request list again').toBe(
      false,
    );
    for (const [list, requests] of ALL) {
      for (const { id } of requests) {
        const hits = text.split(`'${id}'`).length - 1;
        const named = text.split(`id: '${id}'`).length - 1;
        expect(hits, `${list}: ${id} is not spelled out once`).toBe(1);
        expect(named, `${list}: ${id} is not in an id field`).toBe(1);
      }
    }
  });

  it('lets go of every piece the code already draws', () => {
    /**
     * THE HANDOFF, CHECKED FROM THE CODE'S SIDE. The header's rule is that an id
     * leaves this file when its art lands and the code that draws it names it.
     * Every other case here reads only this file, so wiring a sprite and
     * forgetting its entry passed: the artist was still asked for a picture the
     * game already draws, and the catalogue read longer than the work left.
     *
     * The failure names the id and the file that draws it, so the fix is one
     * deletion here. A comment that mentions an id does not count: comments do
     * not draw.
     */
    const files = sourceFiles(SRC);
    const drawnBy = new Map<string, string[]>();
    for (const file of files) {
      const where = `src/${file.href.slice(SRC.href.length)}`;
      for (const name of picturesNamedIn(readFileSync(file, 'utf8'), where)) {
        drawnBy.set(name, [...(drawnBy.get(name) ?? []), where]);
      }
    }

    // A WALK THAT READ NOTHING WOULD PASS. So it must have reached all three
    // halves of src/, and found the hundreds of pictures they already name.
    for (const half of ['client/', 'server/', 'shared/']) {
      expect(
        files.some((file) => file.href.startsWith(`${SRC.href}${half}`)),
        `nothing read under src/${half}`,
      ).toBe(true);
    }
    const pictures = [...drawnBy.keys()].filter((name) =>
      STEMS.some((stem) => name.startsWith(stem)),
    );
    expect(pictures.length, 'the scan found no pictures in src/').toBeGreaterThan(100);

    const drawnAmong = (requests: readonly { readonly id: string }[]): string[] =>
      requests
        .filter(({ id }) => drawnBy.has(id))
        .map(({ id }) => `${id} is drawn by ${(drawnBy.get(id) ?? []).join(', ')}`);
    // AND THE LOOKUP MATCHES WHAT THE SCAN FOUND. The clean answer below is the
    // only one a correct tree gives, so it cannot tell a commission with nothing
    // drawn from a lookup that never matches anything; every picture src/ names
    // must come back as drawn through the same function first.
    expect(drawnAmong(pictures.map((id) => ({ id }))), 'the lookup misses').toHaveLength(
      pictures.length,
    );

    const stillCommissioned = ALL.flatMap(([list, requests]) =>
      drawnAmong(requests).map((line) => `${list}: ${line}`),
    );
    expect(stillCommissioned, 'drawn, and still commissioned').toEqual([]);
  });

  it('counts a string the code passes, never a comment or an `id:` name', () => {
    const source = [
      "// sprite: 'enemy_in_a_line_comment',",
      "/* sprite: 'enemy_in_a_block_comment', */",
      "const note = 'a // inside a string'; const a = { sprite: 'enemy_after_slashes' };",
      "const glob = 'assets/*'; const b = { sprite: 'enemy_after_an_open' }; const end = '*/';",
      "const c = { id: 'item_a_name', icon: 'item_a_picture' };",
      "const d = { id: 'item_a_const_name' as const };",
      'const e = `enemy_no_substitution`;',
      'const f = `enemy_${c.id}`;',
    ].join('\n');
    const pictures = [...picturesNamedIn(source, 'fixture.ts')]
      .filter((name) => STEMS.some((stem) => name.startsWith(stem)))
      .sort();
    expect(pictures).toEqual([
      'enemy_after_an_open',
      'enemy_after_slashes',
      'enemy_no_substitution',
      'item_a_picture',
    ]);
  });
});
