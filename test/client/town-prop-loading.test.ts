// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { makeSettlementMap, townPropsFor } from '../../src/server/content/towns.ts';
import { SITES } from '../../src/server/world/realms.ts';
import { PROP_IDS } from '../../src/shared/props.ts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY FURNISHING A TOWN PLACES IS ONE THE CLIENT ACTUALLY LOADS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The same join test/client/talent-icon-loading.test.ts holds for talent icons,
 * one family over, because the same failure shipped one family over.
 *
 *   server/content/towns.ts places `p(20, 25, 'prop_well')` and forty-eight more.
 *   main.ts's `NEEDED_ASSET_PREFIXES` filters the manifest before loading.
 *
 * The list admitted `prop_eldritch_` and three trap ids. So every lamp post,
 * stall, planter and bench in all five settlements reached `paintProps` with no
 * sprite behind it and drew the violet missing-asset box: a symmetric ring of
 * them around the square in Alderbrook, on a live server where every one of the
 * PNGs was installed, hash-identical to its lane, and served with a 200.
 *
 * `npm run art:needs` said nothing was missing, and nothing was. Both halves of
 * this join are committed source, so it holds on a bare clone too.
 */

const root = new URL('../../', import.meta.url);

/** Comments stripped, the same way `assets.test.ts`'s `codeOf` does it. */
function codeOf(path: string): string {
  return readFileSync(new URL(path, root), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function neededPrefixes(): readonly string[] {
  const block = /const NEEDED_ASSET_PREFIXES = \[([\s\S]*?)\] as const;/.exec(
    codeOf('src/client/main.ts'),
  );
  expect(block, 'NEEDED_ASSET_PREFIXES was renamed or reshaped; this join is blind').not.toBeNull();
  return [...(block?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
}

describe('town furnishings reach the sprite table', () => {
  const settlements = [...SITES.keys()].filter((id) => makeSettlementMap(id) !== undefined);

  it('reads every authored settlement, and finds furniture in them', () => {
    // THE CONTROL. A walk that found no settlement, or a plan with no props,
    // passes the filter below forever.
    expect(settlements).toContain('site:alderbrook');
    expect(settlements.length).toBeGreaterThanOrEqual(5);
    expect(townPropsFor('site:alderbrook').map((p) => p.propId)).toContain('prop_well');
  });

  it('loads every prop a settlement places', () => {
    const prefixes = neededPrefixes();
    const filtered = settlements.flatMap((siteId) =>
      townPropsFor(siteId)
        .filter(({ propId }) => !prefixes.some((prefix) => propId.startsWith(prefix)))
        .map(({ x, y, propId }) => `${siteId} (${String(x)},${String(y)}) ${propId}`),
    );
    expect(filtered, 'filtered out before loading, so drawn as the violet box').toEqual([]);
  });

  it('loads the dressing a delve scatters', () => {
    const prefixes = neededPrefixes();
    expect(PROP_IDS.length).toBeGreaterThan(0);
    expect(PROP_IDS.filter((id) => !prefixes.some((prefix) => id.startsWith(prefix)))).toEqual([]);
  });
});
