// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadFilterPrefixes, scanRepository, unloadedIds } from '../../tools/art-needs-lib.mjs';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE INVENTORY SEES THE CLIENT'S LOAD FILTER, NOT ONLY THE DISK.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `art-needs --missing` compared what source names with what is on disk, and a
 * third thing sits between them: `NEEDED_ASSET_PREFIXES` in src/client/main.ts,
 * which drops every manifest row no prefix admits before a single PNG loads.
 * Every town furnishing was on disk, in the manifest and served, and drew as the
 * violet box; the report listed three ids that had nothing to do with it.
 */

describe('the art inventory reads the load filter', () => {
  it('reads the prefixes from syntax, so a quote in a comment is not a prefix', () => {
    const source = [
      "/** The turn cards' portraits, and `prop_in_backticks`. */",
      'const NEEDED_ASSET_PREFIXES = [',
      "  'chr_player_',",
      "  // 'prop_commented_out',",
      "  /* the town's lamp posts */",
      "  'prop_lamp_post',",
      '] as const;',
      "const OTHER = ['enemy_'];",
    ].join('\n');
    expect(loadFilterPrefixes(source)).toEqual(['chr_player_', 'prop_lamp_post']);
    expect(loadFilterPrefixes("const OTHER = ['enemy_'];")).toBeNull();
  });

  it('names every id source draws that no prefix admits, whether or not it is on disk', () => {
    const runtime = new Map([
      ['prop_lamp_post', new Set(['towns.ts'])],
      ['prop_market_stall', new Set(['towns.ts'])],
      ['chr_player_watchman_s', new Set(['classes.ts'])],
    ]);
    expect(unloadedIds(runtime, ['chr_player_', 'prop_lamp_post'])).toEqual(['prop_market_stall']);
    expect(unloadedIds(runtime, [])).toEqual([
      'chr_player_watchman_s',
      'prop_lamp_post',
      'prop_market_stall',
    ]);
  });

  it('finds the real filter, and every art id in src/ passes it', () => {
    const repo = fileURLToPath(new URL('../..', import.meta.url));
    const prefixes = loadFilterPrefixes(
      readFileSync(new URL('../../src/client/main.ts', import.meta.url), 'utf8'),
    );
    // THE CONTROL: a parse that found nothing would admit nothing and flag all.
    expect(prefixes).not.toBeNull();
    expect(prefixes).toContain('tile_local_');
    expect(prefixes).toContain('prop_well');

    const { runtime } = scanRepository(repo);
    expect(runtime.has('prop_well')).toBe(true);
    expect(unloadedIds(runtime, prefixes ?? [])).toEqual([]);
  });
});
