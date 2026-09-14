// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Dalton Barraclough

import { describe, expect, it } from 'vitest';

import { ENCOUNTER_SITE, SITES } from '../../src/server/world/realms.ts';
import { createWorld } from '../../src/server/world/world.ts';
import { REDACTION_SITE_ID } from '../../src/shared/level.ts';

/** How many of a site's tiles its own light reaches, built as a realm builds it. */
function litCount(id: string): { readonly lit: number; readonly of: number } {
  const def = SITES.get(id);
  if (def === undefined) throw new Error(`no site ${id}`);
  const seed = `lighting:${id}`;
  const world = createWorld(seed, def.map(seed), id, def.lighting);
  let lit = 0;
  for (const tile of world.lit) lit += tile;
  return { lit, of: world.lit.length };
}

const TOWNS = ['site:alderbrook', 'site:threadneedle_row', 'site:ashwick_row', 'site:saints_rest'];
const RUINS = [
  'site:wayfarers_camp',
  'site:watchers_altar',
  'site:drowned_chapel',
  'site:barrow_end',
];
const CAVES = ['site:blackwood_outskirts', 'site:underworks', 'site:hollow_mine', 'site:cairnfoot'];
const WORKS = ['site:gearford_ward', 'site:glass_archive', 'site:outer_index', 'site:the_weir'];

describe('how each place is lit', () => {
  it('lights every tile of a town and of a ruin', () => {
    for (const id of [...TOWNS, ...RUINS]) {
      const { lit, of } = litCount(id);
      expect(lit, id).toBe(of);
    }
  });

  it('lights nothing in a cave', () => {
    for (const id of CAVES) expect(litCount(id).lit, id).toBe(0);
  });

  it('lights the rooms of a works and leaves the ground outside them dark', () => {
    for (const id of WORKS) {
      const { lit, of } = litCount(id);
      expect(lit, `${id}: no room was lit`).toBeGreaterThan(0);
      expect(lit, `${id}: nothing was left dark`).toBeLessThan(of);
    }
  });

  it('gives each of the Redaction’s twins its original’s light', () => {
    const twins = [...SITES.keys()].filter((id) => id.startsWith(`${REDACTION_SITE_ID}:`));
    expect(twins.length, 'no twins to check').toBeGreaterThan(0);
    const darkTwins = twins.filter((twin) => {
      const original = twin.replace(`${REDACTION_SITE_ID}:`, 'site:');
      expect(SITES.get(twin)?.lighting, twin).toEqual(SITES.get(original)?.lighting);
      return CAVES.includes(original);
    });
    expect(darkTwins.length, 'no twin of a cave, so the dark case is unchecked').toBeGreaterThan(0);
  });

  it('keeps the Redaction’s moor and the breach arena lit', () => {
    expect(SITES.get(REDACTION_SITE_ID)?.lighting).toBeUndefined();
    expect(ENCOUNTER_SITE.lighting).toBeUndefined();
  });
});
